export type PostUiProbeOutcome =
  | "post-ui-pen-missing-before-document-listener"
  | "post-ui-pen-missed-page-router"
  | "post-ui-pen-seen-document-not-router"
  | "post-ui-pen-fallback-rejected"
  | "post-ui-pen-already-handled"
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

export type PostUiProbeOutcomeClass = "classification" | "routing" | "annotation-native-conflict" | "lifecycle";

export type PostUiProbeStage =
  | "document"
  | "document-capture"
  | "hit-test"
  | "router-received"
  | "router-rejected"
  | "fallback"
  | "route"
  | "fallback"
  | "pan"
  | "native"
  | "claim"
  | "stroke-start"
  | "terminal"
  | "lifecycle"
  | "zoom";

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

export interface PostUiProbeTraceFrame {
  at: number;
  stage: PostUiProbeStage;
  details: Record<string, unknown>;
}

export interface PostUiProbeContactSummary {
  armId: string;
  correlationId: string;
  physicalContactId: string | null;
  penContactId: string | null;
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
  lastObservedStage: PostUiProbeStage | null;
  rollingContext: PostUiProbeTraceFrame[];
  stages: PostUiProbeStage[];
  route: string | null;
  routeReason: string | null;
  page: number | null;
  routerGeneration: number | null;
  eventPhase: number | null;
  composedPathLength: number | null;
  targetOwnership: string | null;
  fallbackConsidered: boolean;
  fallbackDecision: string | null;
  panObserved: boolean;
  panAccepted: boolean;
  nativeScrollBefore: { left: number; top: number } | null;
  nativeMaxScrollDeltaPx: number;
  nativeScrollAfter: { left: number; top: number } | null;
  strokeStarted: boolean;
  terminal: string | null;
  terminalState: string | null;
  details: Record<string, unknown>;
}

export interface PostUiProbeResult {
  armId: string;
  correlationId: string | null;
  penContactId: string | null;
  outcome: PostUiProbeOutcome;
  outcomeClass: PostUiProbeOutcomeClass;
  elapsedMs: number;
  pointerDownCount: number;
  observedPointerTypes: string[];
  contactCount: number;
  contact: PostUiProbeContactSummary | null;
  details: Record<string, unknown>;
}

interface ScrollSnapshot {
  left: number;
  top: number;
}

interface ProbeContact {
  armId: string;
  correlationId: string;
  physicalContactId: string | null;
  pointerId: number;
  pointerType: string;
  startedAt: number;
  penContactIndex: number | null;
  documentSeen: boolean;
  routerReceived: boolean;
  fallbackConsidered: boolean;
  fallbackEligible: boolean | null;
  fallbackRejectedReason: string | null;
  lastObservedStage: PostUiProbeStage | null;
  rollingContext: PostUiProbeTraceFrame[];
  stages: PostUiProbeStage[];
  route: string | null;
  routeReason: string | null;
  page: number | null;
  routerGeneration: number | null;
  eventPhase: number | null;
  composedPathLength: number | null;
  targetOwnership: string | null;
  fallbackConsidered: boolean;
  fallbackDecision: string | null;
  panObserved: boolean;
  panAccepted: boolean;
  nativeScrollBefore: ScrollSnapshot | null;
  nativeMaxScrollDeltaPx: number;
  nativeScrollAfter: ScrollSnapshot | null;
  strokeStarted: boolean;
  terminal: string | null;
  terminalState: string | null;
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
  penContactCount: number;
  acceptingContacts: boolean;
}

function scrollSnapshot(value: unknown): ScrollSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { left?: unknown; top?: unknown };
  return typeof candidate.left === "number" && typeof candidate.top === "number"
    ? { left: candidate.left, top: candidate.top }
    : null;
}

export class PostUiInputProbe {
  static readonly WINDOW_MS = 1_500;
  static readonly MAX_POINTER_DOWNS = 4;
  static readonly MAX_HANDOFF_CONTACTS = 8;
  static readonly MAX_TRACE_CONTEXT = 8;

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
      penContactCount: 0,
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

  pointerDown(
    now: number,
    pointerId: number,
    pointerType: string,
    details: Record<string, unknown> = {}
  ): PostUiProbeContactSummary | null {
    const active = this.active;
    if (!active || now >= active.expiresAt || !active.acceptingContacts) return null;
    if (active.pointerDownCount >= PostUiInputProbe.MAX_POINTER_DOWNS) return null;
    active.pointerDownCount += 1;
    const normalizedType = pointerType || "(empty)";
    active.observedPointerTypes.add(normalizedType);

    const existing = active.contacts.get(pointerId);
    if (existing) return this.summary(existing, now);
    const contactNumber = pointerType === "pen" ? ++active.penContactCount : 0;
    const contact: ProbeContact = {
      armId: active.armId,
      correlationId: `${active.armId}-contact-${active.contacts.size + 1}`,
      contactNumber,
      pointerId,
      pointerType: pointerType || "(empty)",
      startedAt: now,
      stages: ["document"],
      route: null,
      routeReason: null,
      page: null,
      routerGeneration: null,
      eventPhase: null,
      composedPathLength: null,
      targetOwnership: null,
      fallbackConsidered: false,
      fallbackDecision: null,
      panObserved: false,
      panAccepted: false,
      nativeScrollBefore: null,
      nativeMaxScrollDeltaPx: 0,
      nativeScrollAfter: null,
      strokeStarted: false,
      terminal: null,
      terminalState: null,
      finalized: false,
      details: {
        documentSeen: true,
        contactNumber,
        ...(pointerType === "pen" ? { eligiblePenContact: true } : { eligiblePenContact: false })
      }
    };
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
    this.applyStage(contact, stage, details, now);
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
    this.applyStage(contact, "terminal", { ...details, terminal }, now);
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
    if (!contact.stages.includes(stage)) contact.stages.push(stage);
    Object.assign(contact.details, details);
    if (typeof details.page === "number") contact.page = details.page;
    if (typeof details.routerGeneration === "number") contact.routerGeneration = details.routerGeneration;
    if (typeof details.route === "string") contact.route = details.route;
    if (typeof details.routeReason === "string") contact.routeReason = details.routeReason;
    if (typeof details.eventPhase === "number") contact.eventPhase = details.eventPhase;
    if (typeof details.composedPathLength === "number") contact.composedPathLength = details.composedPathLength;
    if (typeof details.targetOwnership === "string") contact.targetOwnership = details.targetOwnership;
    if (details.fallbackConsidered === true) contact.fallbackConsidered = true;
    if (typeof details.fallbackDecision === "string") contact.fallbackDecision = details.fallbackDecision;
    if (stage === "pan") {
      contact.panObserved = true;
      if (details.accepted === true) contact.panAccepted = true;
    }
    if (stage === "native") {
      const before = scrollSnapshot(details.scrollBefore);
      const after = scrollSnapshot(details.scrollAfter);
      contact.nativeScrollBefore ??= before;
      if (after) contact.nativeScrollAfter = after;
      const delta = typeof details.nativeScrollDeltaPx === "number"
        ? Math.max(0, details.nativeScrollDeltaPx)
        : before && after
          ? Math.max(Math.abs(after.left - before.left), Math.abs(after.top - before.top))
          : 0;
      contact.nativeMaxScrollDeltaPx = Math.max(contact.nativeMaxScrollDeltaPx, delta);
    }
    if (stage === "stroke-start") {
      contact.strokeStarted = true;
      if (this.active) this.active.acceptingContacts = false;
    }
    if (stage === "terminal") {
      if (typeof details.terminal === "string") contact.terminal = details.terminal;
      if (typeof details.terminalState === "string") contact.terminalState = details.terminalState;
    }
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
    this.stage(now, pointerId, "terminal", { ...details, terminal });
    contact.finalized = true;
    return {
      armId: active.armId,
      correlationId: contact.correlationId,
      outcome: this.outcomeFor(contact),
      elapsedMs: Math.max(0, now - active.armedAt),
      pointerDownCount: active.pointerDownCount,
      observedPointerTypes: [...active.observedPointerTypes],
      contactCount: active.contacts.size,
      contact: this.summary(contact, now),
      details: { ...this.contextDetails(active), ...contact.details, ...details }
    };
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
    this.stage(now, pointerId, "terminal", { ...details, terminal: "pointerdown", terminalState: "explicit", outcome });
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
        outcomeClass: "classification",
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
    const physicalContactId = typeof details.physicalContactId === "string" ? details.physicalContactId : null;
    const initialTrace: PostUiProbeTraceFrame = {
      at: startedAt,
      stage: "document",
      details: boundedTraceDetails(details)
    };
    return {
      armId,
      correlationId,
      physicalContactId,
      pointerId,
      pointerType,
      startedAt,
      penContactIndex,
      documentSeen: details.documentSeen === true,
      routerReceived: false,
      fallbackConsidered: false,
      fallbackEligible: null,
      fallbackRejectedReason: null,
      lastObservedStage: "document",
      rollingContext: [initialTrace],
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

  private applyStage(contact: ProbeContact, stage: PostUiProbeStage, details: Record<string, unknown>, at: number): void {
    if (!contact.stages.includes(stage)) contact.stages.push(stage);
    contact.lastObservedStage = stage;
    contact.rollingContext.push({ at, stage, details: boundedTraceDetails(details) });
    if (contact.rollingContext.length > PostUiInputProbe.MAX_TRACE_CONTEXT) {
      contact.rollingContext.splice(0, contact.rollingContext.length - PostUiInputProbe.MAX_TRACE_CONTEXT);
    }
    Object.assign(contact.details, details);
    if (stage === "document" || stage === "document-capture") contact.documentSeen = true;
    if (stage === "router-received") contact.routerReceived = true;
    if (stage === "fallback") {
      contact.fallbackConsidered = details.fallbackConsidered !== false;
      contact.fallbackEligible = typeof details.fallbackEligible === "boolean" ? details.fallbackEligible : contact.fallbackEligible;
    }
    if (typeof details.fallbackRejectedReason === "string") contact.fallbackRejectedReason = details.fallbackRejectedReason;
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
    if (contact.details.alreadyHandled === true || contact.details.rejection === "already-handled") {
      return "post-ui-pen-already-handled";
    }
    if (contact.details.fallbackRejected === true) return "post-ui-pen-fallback-rejected";
    if (!contact.stages.includes("router-received")) {
      return contact.details.legacyMissedPageRouter === true
        ? "post-ui-pen-missed-page-router"
        : "post-ui-pen-seen-document-not-router";
    }
    if (contact.panAccepted) return "post-ui-pen-entered-pan";
    if (contact.route === "native" || contact.route === "touch-pan" || contact.route === "touch-zoom-pan") {
      return "post-ui-pen-routed-native";
    }
    if (contact.details.claimFailed === true || (contact.route && !contact.stages.includes("claim"))) {
      return "post-ui-pen-claim-failed";
    }
    return "post-ui-pen-cancelled-before-ink";
  }

  private outcomeClass(outcome: PostUiProbeOutcome): PostUiProbeOutcomeClass {
    if (outcome === "post-ui-probe-expired-no-pen" || outcome === "post-ui-pen-missing-before-document-listener") {
      return "classification";
    }
    if (outcome === "post-ui-pen-routed-native" || outcome === "post-ui-pen-entered-pan" || outcome === "post-ui-pen-ui-occluded") {
      return "annotation-native-conflict";
    }
    if (outcome === "post-ui-pen-success" || outcome === "post-ui-pen-cancelled-before-ink") return "lifecycle";
    return "routing";
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
      penContactId: this.penContactIdFor(contact),
      outcome,
      outcomeClass: this.outcomeClass(outcome),
      elapsedMs: Math.max(0, now - active.armedAt),
      pointerDownCount: active.pointerDownCount,
      observedPointerTypes: [...active.observedPointerTypes],
      contactCount: active.contacts.size,
      contact: this.summary(contact, now),
      details: {
        ...this.contextDetails(active),
        ...contact.details,
        physicalContactId: contact.physicalContactId,
        trace: {
          physicalContactId: contact.physicalContactId,
          lastObservedStage: contact.lastObservedStage,
          fallbackRejectedReason: contact.fallbackRejectedReason,
          rollingContext: contact.rollingContext
        },
        ...details
      }
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
      penContactId: this.penContactIdFor(contact),
      outcome,
      outcomeClass: this.outcomeClass(outcome),
      elapsedMs: Math.max(0, now - contact.startedAt),
      pointerDownCount: 1,
      observedPointerTypes: [contact.pointerType],
      contactCount: 1,
      contact: this.summary(contact, now),
      details: {
        ...contact.details,
        physicalContactId: contact.physicalContactId,
        trace: {
          physicalContactId: contact.physicalContactId,
          lastObservedStage: contact.lastObservedStage,
          fallbackRejectedReason: contact.fallbackRejectedReason,
          rollingContext: contact.rollingContext
        },
        ...details
      }
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

  private penContactIdFor(contact: ProbeContact): string | null {
    return contact.pointerType === "pen" ? contact.correlationId : null;
  }

  private summary(contact: ProbeContact, now: number): PostUiProbeContactSummary {
    return {
      armId: contact.armId,
      correlationId: contact.correlationId,
      physicalContactId: contact.physicalContactId,
      penContactId: this.penContactIdFor(contact),
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
      lastObservedStage: contact.lastObservedStage,
      rollingContext: contact.rollingContext.map((frame) => ({
        ...frame,
        details: { ...frame.details }
      })),
      stages: [...contact.stages],
      route: contact.route,
      routeReason: contact.routeReason,
      page: contact.page,
      routerGeneration: contact.routerGeneration,
      eventPhase: contact.eventPhase,
      composedPathLength: contact.composedPathLength,
      targetOwnership: contact.targetOwnership,
      fallbackConsidered: contact.fallbackConsidered,
      fallbackDecision: contact.fallbackDecision,
      panObserved: contact.panObserved,
      panAccepted: contact.panAccepted,
      nativeScrollBefore: contact.nativeScrollBefore,
      nativeMaxScrollDeltaPx: contact.nativeMaxScrollDeltaPx,
      nativeScrollAfter: contact.nativeScrollAfter,
      strokeStarted: contact.strokeStarted,
      terminal: contact.terminal,
      terminalState: contact.terminalState,
      details: { ...contact.details }
    };
  }
}

function boundedTraceDetails(details: Record<string, unknown>): Record<string, unknown> {
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details).slice(0, 32)) {
    bounded[key] = boundedTraceValue(value, 0);
  }
  return bounded;
}

function boundedTraceValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 3) return "[bounded]";
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => boundedTraceValue(item, depth + 1));
  if (typeof value !== "object") return "[bounded]";
  const bounded: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 24)) {
    bounded[key] = boundedTraceValue(child, depth + 1);
  }
  return bounded;
}
