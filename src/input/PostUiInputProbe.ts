export type PostUiProbeOutcome =
  | "post-ui-pen-missing-before-document-listener"
  | "post-ui-pen-missed-page-router"
  | "pen-seen-document-not-router"
  | "post-ui-pen-fallback-rejected"
  | "post-ui-pen-ui-occluded"
  | "post-ui-pen-routed-native"
  | "post-ui-pen-entered-pan"
  | "post-ui-pen-stale-router"
  | "post-ui-pen-claim-failed"
  | "post-ui-pen-cancelled-before-ink"
  | "post-ui-pen-success"
  | "post-ui-probe-expired-no-pen"
  | "pen-routing-regression"
  | "post-tool-change-routing-regression";

export type PostUiProbeStage =
  | "document"
  | "document-capture"
  | "hit-test"
  | "router-received"
  | "router-rejected"
  | "fallback"
  | "route"
  | "pan"
  | "claim"
  | "stroke-start"
  | "native-evidence"
  | "terminal";

export interface PostUiProbeArmContext {
  sessionId: string;
  viewerGeneration: number;
  pageGeneration: number | null;
  mountedPages: number[];
  documentPath: string;
  transition: Record<string, unknown>;
  uiCloseAt?: number | null;
  lastSuccessfulStrokeAt?: number | null;
  lastZoomSettleAt?: number | null;
  lastTouchPanAt?: number | null;
  lastRouterBindAt?: number | null;
  lastPageReplacementAt?: number | null;
}

export interface PostUiProbeContactSummary {
  armId: string;
  correlationId: string;
  penContactId: string;
  pointerId: number;
  pointerType: string;
  startedAt: number;
  elapsedMs: number;
  penContactIndex: number | null;
  documentSeen: boolean;
  routerReceived: boolean;
  fallbackConsidered: boolean;
  fallbackEligible: boolean | null;
  fallbackRejectedReason: string | null;
  stages: PostUiProbeStage[];
  route: string | null;
  routeReason: string | null;
  page: number | null;
  routerGeneration: number | null;
  panObserved: boolean;
  panAccepted: boolean;
  nativeScrollDeltaPx: number;
  strokeStarted: boolean;
  terminal: string | null;
}

export interface PostUiProbeResult {
  armId: string;
  correlationId: string | null;
  penContactId: string | null;
  outcome: PostUiProbeOutcome;
  elapsedMs: number;
  pointerDownCount: number;
  observedPointerTypes: string[];
  contactCount: number;
  contact: PostUiProbeContactSummary | null;
  details: Record<string, unknown>;
}

interface ProbeContact {
  armId: string;
  correlationId: string;
  pointerId: number;
  pointerType: string;
  startedAt: number;
  penContactIndex: number | null;
  documentSeen: boolean;
  routerReceived: boolean;
  fallbackConsidered: boolean;
  fallbackEligible: boolean | null;
  fallbackRejectedReason: string | null;
  stages: PostUiProbeStage[];
  route: string | null;
  routeReason: string | null;
  page: number | null;
  routerGeneration: number | null;
  panObserved: boolean;
  panAccepted: boolean;
  nativeScrollDeltaPx: number;
  strokeStarted: boolean;
  terminal: string | null;
  finalized: boolean;
  details: Record<string, unknown>;
}

interface ActiveProbe {
  armId: string;
  armedAt: number;
  expiresAt: number;
  context: PostUiProbeArmContext;
  pointerDownCount: number;
  penContactCount: number;
  observedPointerTypes: Set<string>;
  contacts: Map<number, ProbeContact>;
  acceptingContacts: boolean;
}

/**
 * Bounded input diagnostics state. The armed half covers the short post-UI
 * window; the unarmed handoff half follows every real Pencil contact so a
 * failure that happens after zoom or touch still has a correlation ID.
 */
export class PostUiInputProbe {
  static readonly WINDOW_MS = 1_500;
  static readonly MAX_POINTER_DOWNS = 4;
  static readonly MAX_HANDOFF_CONTACTS = 8;

  private sequence = 0;
  private handoffSequence = 0;
  private active: ActiveProbe | null = null;
  private readonly handoffContacts = new Map<number, ProbeContact>();

  arm(now: number, context: PostUiProbeArmContext): { armId: string; expiresAt: number } {
    const armId = `post-ui-${++this.sequence}`;
    this.active = {
      armId,
      armedAt: now,
      expiresAt: now + PostUiInputProbe.WINDOW_MS,
      context,
      pointerDownCount: 0,
      penContactCount: 0,
      observedPointerTypes: new Set<string>(),
      contacts: new Map<number, ProbeContact>(),
      acceptingContacts: true
    };
    return { armId, expiresAt: now + PostUiInputProbe.WINDOW_MS };
  }

  isArmed(now: number): boolean {
    return Boolean(this.active && this.active.acceptingContacts && now < this.active.expiresAt);
  }

  expiresAt(): number | null {
    return this.active?.expiresAt ?? null;
  }

  armId(): string | null {
    return this.active?.armId ?? null;
  }

  pointerDown(now: number, pointerId: number, pointerType: string): PostUiProbeContactSummary | null {
    const active = this.active;
    if (!active || now >= active.expiresAt || !active.acceptingContacts) return null;
    if (active.pointerDownCount >= PostUiInputProbe.MAX_POINTER_DOWNS) return null;
    active.pointerDownCount += 1;
    const normalizedType = pointerType || "(empty)";
    active.observedPointerTypes.add(normalizedType);

    const existing = active.contacts.get(pointerId);
    if (existing) return this.summary(existing, now);
    const contact = this.createContact(
      active.armId,
      `${active.armId}-contact-${active.contacts.size + 1}`,
      now,
      pointerId,
      normalizedType,
      normalizedType === "pen" ? ++active.penContactCount : null,
      { documentSeen: true }
    );
    active.contacts.set(pointerId, contact);
    return this.summary(contact, now);
  }

  /** Start a session-level trace for every real Pencil document-capture contact. */
  observeDocument(
    now: number,
    pointerId: number,
    pointerType: string,
    details: Record<string, unknown> = {}
  ): PostUiProbeContactSummary | null {
    if (pointerType !== "pen") return null;
    const existing = this.handoffContacts.get(pointerId);
    if (existing) {
      Object.assign(existing.details, details);
      return this.summary(existing, now);
    }
    while (this.handoffContacts.size >= PostUiInputProbe.MAX_HANDOFF_CONTACTS) {
      const oldest = this.handoffContacts.keys().next().value;
      if (typeof oldest !== "number") break;
      this.handoffContacts.delete(oldest);
    }
    const contact = this.createContact(
      "pen-routing",
      `pen-routing-${++this.handoffSequence}`,
      now,
      pointerId,
      "pen",
      this.handoffSequence,
      { documentSeen: true, ...details }
    );
    this.handoffContacts.set(pointerId, contact);
    return this.summary(contact, now);
  }

  handoffCorrelationId(pointerId: number): string | null {
    return this.handoffContacts.get(pointerId)?.correlationId ?? null;
  }

  handoffSummary(pointerId: number, now = Date.now()): PostUiProbeContactSummary | null {
    const contact = this.handoffContacts.get(pointerId);
    return contact && !contact.finalized ? this.summary(contact, now) : null;
  }

  handoffStage(
    now: number,
    pointerId: number,
    stage: PostUiProbeStage,
    details: Record<string, unknown> = {}
  ): PostUiProbeContactSummary | null {
    const contact = this.handoffContacts.get(pointerId);
    if (!contact || contact.finalized) return null;
    this.applyStage(contact, stage, details);
    return this.summary(contact, now);
  }

  finishHandoff(
    now: number,
    pointerId: number,
    terminal: string,
    outcome?: PostUiProbeOutcome,
    details: Record<string, unknown> = {}
  ): PostUiProbeResult | null {
    const contact = this.handoffContacts.get(pointerId);
    if (!contact || contact.finalized) return null;
    this.applyStage(contact, "terminal", { ...details, terminal });
    contact.finalized = true;
    const result = this.resultWithoutContext(contact, outcome ?? this.outcomeFor(contact), now, details);
    this.handoffContacts.delete(pointerId);
    return result;
  }

  expireHandoffs(now: number): PostUiProbeResult[] {
    const results: PostUiProbeResult[] = [];
    for (const [pointerId, contact] of this.handoffContacts) {
      if (now - contact.startedAt < PostUiInputProbe.WINDOW_MS) continue;
      contact.finalized = true;
      results.push(this.resultWithoutContext(contact, this.outcomeFor(contact), now, { expired: true }));
      this.handoffContacts.delete(pointerId);
    }
    return results;
  }

  correlationId(pointerId: number): string | null {
    return this.active?.contacts.get(pointerId)?.correlationId ?? null;
  }

  stage(
    now: number,
    pointerId: number,
    stage: PostUiProbeStage,
    details: Record<string, unknown> = {}
  ): PostUiProbeContactSummary | null {
    const contact = this.active?.contacts.get(pointerId);
    if (!contact || contact.finalized) return null;
    this.applyStage(contact, stage, details);
    if (stage === "stroke-start" && this.active) this.active.acceptingContacts = false;
    return this.summary(contact, now);
  }

  finish(
    now: number,
    pointerId: number,
    terminal: string,
    details: Record<string, unknown> = {}
  ): PostUiProbeResult | null {
    const active = this.active;
    const contact = active?.contacts.get(pointerId);
    if (!active || !contact || contact.finalized) return null;
    this.applyStage(contact, "terminal", { ...details, terminal });
    contact.finalized = true;
    if (contact.pointerType !== "pen") return null;
    return this.result(active, contact, this.outcomeFor(contact), now, details);
  }

  finishWithOutcome(
    now: number,
    pointerId: number,
    outcome: PostUiProbeOutcome,
    details: Record<string, unknown> = {}
  ): PostUiProbeResult | null {
    const active = this.active;
    const contact = active?.contacts.get(pointerId);
    if (!active || !contact || contact.finalized) return null;
    this.applyStage(contact, "terminal", { ...details, terminal: "pointerdown", outcome });
    contact.finalized = true;
    if (contact.pointerType !== "pen") return null;
    return this.result(active, contact, outcome, now, details);
  }

  expire(now: number): PostUiProbeResult[] {
    const active = this.active;
    if (!active || now < active.expiresAt) return [];
    active.acceptingContacts = false;
    const results: PostUiProbeResult[] = [];
    const observedPen = [...active.contacts.values()].some((contact) => contact.pointerType === "pen");
    for (const contact of active.contacts.values()) {
      if (contact.finalized) continue;
      contact.finalized = true;
      // Touch is useful context, but it is never evidence of a Pencil route
      // failure. Only real pen contacts receive a Pencil-specific outcome.
      if (contact.pointerType === "pen") {
        results.push(this.result(active, contact, this.outcomeFor(contact), now, { expired: true }));
      }
    }
    if (!observedPen) {
      const observedPointerTypes = [...active.observedPointerTypes];
      results.push({
        armId: active.armId,
        correlationId: null,
        penContactId: null,
        outcome: "post-ui-probe-expired-no-pen",
        elapsedMs: Math.max(0, now - active.armedAt),
        pointerDownCount: active.pointerDownCount,
        observedPointerTypes,
        contactCount: active.contacts.size,
        contact: null,
        details: {
          ...this.contextDetails(active),
          expired: true,
          penObserved: false,
          observedPointerTypes,
          contactCount: active.contacts.size
        }
      });
    }
    return results;
  }

  private createContact(
    armId: string,
    correlationId: string,
    startedAt: number,
    pointerId: number,
    pointerType: string,
    penContactIndex: number | null,
    details: Record<string, unknown>
  ): ProbeContact {
    return {
      armId,
      correlationId,
      pointerId,
      pointerType,
      startedAt,
      penContactIndex,
      documentSeen: details.documentSeen === true,
      routerReceived: false,
      fallbackConsidered: false,
      fallbackEligible: null,
      fallbackRejectedReason: null,
      stages: ["document"],
      route: null,
      routeReason: null,
      page: null,
      routerGeneration: null,
      panObserved: false,
      panAccepted: false,
      nativeScrollDeltaPx: 0,
      strokeStarted: false,
      terminal: null,
      finalized: false,
      details: { ...details }
    };
  }

  private applyStage(contact: ProbeContact, stage: PostUiProbeStage, details: Record<string, unknown>): void {
    if (!contact.stages.includes(stage)) contact.stages.push(stage);
    Object.assign(contact.details, details);
    if (stage === "document" || stage === "document-capture") contact.documentSeen = true;
    if (stage === "router-received") contact.routerReceived = true;
    if (stage === "fallback") {
      contact.fallbackConsidered = details.fallbackConsidered !== false;
      contact.fallbackEligible = typeof details.fallbackEligible === "boolean" ? details.fallbackEligible : contact.fallbackEligible;
      if (typeof details.fallbackRejectedReason === "string") contact.fallbackRejectedReason = details.fallbackRejectedReason;
    }
    if (typeof details.page === "number") contact.page = details.page;
    if (typeof details.routerGeneration === "number") contact.routerGeneration = details.routerGeneration;
    if (typeof details.route === "string") contact.route = details.route;
    if (typeof details.routeReason === "string") contact.routeReason = details.routeReason;
    if (typeof details.maxScrollDeltaPx === "number") contact.nativeScrollDeltaPx = Math.max(contact.nativeScrollDeltaPx, details.maxScrollDeltaPx);
    if (stage === "pan") {
      contact.panObserved = true;
      if (details.accepted === true) contact.panAccepted = true;
    }
    if (stage === "stroke-start") contact.strokeStarted = true;
    if (stage === "terminal" && typeof details.terminal === "string") contact.terminal = details.terminal;
  }

  private outcomeFor(contact: ProbeContact): PostUiProbeOutcome {
    if (contact.pointerType !== "pen") return "post-ui-probe-expired-no-pen";
    if (contact.strokeStarted) return "post-ui-pen-success";
    if (contact.details.pageOccludedByUi === true || contact.details.occluded === true) {
      return "post-ui-pen-ui-occluded";
    }
    if (contact.details.staleRouter === true) return "post-ui-pen-stale-router";
    if (contact.details.fallbackRejected === true) return "post-ui-pen-fallback-rejected";
    if (contact.details.penSeenDocumentNotRouter === true) return "pen-seen-document-not-router";
    if (!contact.routerReceived) return "post-ui-pen-missed-page-router";
    if (contact.panAccepted) return "post-ui-pen-entered-pan";
    if (contact.route === "native" || contact.route === "touch-pan" || contact.route === "touch-zoom-pan") {
      return "post-ui-pen-routed-native";
    }
    if (contact.details.claimFailed === true || (contact.route && !contact.stages.includes("claim"))) {
      return "post-ui-pen-claim-failed";
    }
    return "post-ui-pen-cancelled-before-ink";
  }

  private result(
    active: ActiveProbe,
    contact: ProbeContact,
    outcome: PostUiProbeOutcome,
    now: number,
    details: Record<string, unknown>
  ): PostUiProbeResult {
    return {
      armId: active.armId,
      correlationId: contact.correlationId,
      penContactId: contact.correlationId,
      outcome,
      elapsedMs: Math.max(0, now - active.armedAt),
      pointerDownCount: active.pointerDownCount,
      observedPointerTypes: [...active.observedPointerTypes],
      contactCount: active.contacts.size,
      contact: this.summary(contact, now),
      details: { ...this.contextDetails(active), ...contact.details, ...details }
    };
  }

  private resultWithoutContext(
    contact: ProbeContact,
    outcome: PostUiProbeOutcome,
    now: number,
    details: Record<string, unknown>
  ): PostUiProbeResult {
    return {
      armId: contact.armId,
      correlationId: contact.correlationId,
      penContactId: contact.correlationId,
      outcome,
      elapsedMs: Math.max(0, now - contact.startedAt),
      pointerDownCount: 1,
      observedPointerTypes: [contact.pointerType],
      contactCount: 1,
      contact: this.summary(contact, now),
      details: { ...contact.details, ...details }
    };
  }

  private contextDetails(active: ActiveProbe): Record<string, unknown> {
    return {
      sessionId: active.context.sessionId,
      viewerGeneration: active.context.viewerGeneration,
      pageGeneration: active.context.pageGeneration,
      mountedPages: active.context.mountedPages,
      documentPath: active.context.documentPath,
      transition: active.context.transition,
      ...(active.context.uiCloseAt !== undefined ? { uiCloseAt: active.context.uiCloseAt } : {}),
      ...(active.context.lastSuccessfulStrokeAt !== undefined ? { lastSuccessfulStrokeAt: active.context.lastSuccessfulStrokeAt } : {}),
      ...(active.context.lastZoomSettleAt !== undefined ? { lastZoomSettleAt: active.context.lastZoomSettleAt } : {}),
      ...(active.context.lastTouchPanAt !== undefined ? { lastTouchPanAt: active.context.lastTouchPanAt } : {}),
      ...(active.context.lastRouterBindAt !== undefined ? { lastRouterBindAt: active.context.lastRouterBindAt } : {}),
      ...(active.context.lastPageReplacementAt !== undefined ? { lastPageReplacementAt: active.context.lastPageReplacementAt } : {})
    };
  }

  private summary(contact: ProbeContact, now: number): PostUiProbeContactSummary {
    return {
      armId: contact.armId,
      correlationId: contact.correlationId,
      penContactId: contact.correlationId,
      pointerId: contact.pointerId,
      pointerType: contact.pointerType,
      startedAt: contact.startedAt,
      elapsedMs: Math.max(0, now - contact.startedAt),
      penContactIndex: contact.penContactIndex,
      documentSeen: contact.documentSeen,
      routerReceived: contact.routerReceived,
      fallbackConsidered: contact.fallbackConsidered,
      fallbackEligible: contact.fallbackEligible,
      fallbackRejectedReason: contact.fallbackRejectedReason,
      stages: [...contact.stages],
      route: contact.route,
      routeReason: contact.routeReason,
      page: contact.page,
      routerGeneration: contact.routerGeneration,
      panObserved: contact.panObserved,
      panAccepted: contact.panAccepted,
      nativeScrollDeltaPx: contact.nativeScrollDeltaPx,
      strokeStarted: contact.strokeStarted,
      terminal: contact.terminal
    };
  }
}
