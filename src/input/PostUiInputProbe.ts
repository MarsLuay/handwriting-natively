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
  | "post-ui-probe-touch-contact";

export type PostUiProbeStage =
  | "document"
  | "hit-test"
  | "router-received"
  | "router-rejected"
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
}

export interface PostUiProbeContactSummary {
  armId: string;
  correlationId: string;
  contactNumber: number;
  pointerId: number;
  pointerType: string;
  startedAt: number;
  elapsedMs: number;
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
  outcome: PostUiProbeOutcome;
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
  contactNumber: number;
  pointerId: number;
  pointerType: string;
  startedAt: number;
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

  private sequence = 0;
  private active: ActiveProbe | null = null;

  arm(now: number, context: PostUiProbeArmContext): { armId: string; expiresAt: number } {
    const armId = `post-ui-${++this.sequence}`;
    this.active = {
      armId,
      armedAt: now,
      expiresAt: now + PostUiInputProbe.WINDOW_MS,
      context,
      pointerDownCount: 0,
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

  pointerDown(now: number, pointerId: number, pointerType: string): PostUiProbeContactSummary | null {
    const active = this.active;
    if (!active || now >= active.expiresAt || !active.acceptingContacts) return null;
    if (active.pointerDownCount >= PostUiInputProbe.MAX_POINTER_DOWNS) return null;
    active.pointerDownCount += 1;
    active.observedPointerTypes.add(pointerType || "(empty)");

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
    this.stage(now, pointerId, "terminal", { ...details, terminal, terminalState: terminal });
    contact.finalized = true;
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
    this.stage(now, pointerId, "terminal", { ...details, terminal: "pointerdown", terminalState: "explicit", outcome });
    contact.finalized = true;
    return this.result(active, contact, outcome, now, details);
  }

  expire(now: number): PostUiProbeResult[] {
    const active = this.active;
    if (!active || now < active.expiresAt) return [];
    active.acceptingContacts = false;
    const results: PostUiProbeResult[] = [];
    for (const contact of active.contacts.values()) {
      if (contact.finalized) continue;
      contact.finalized = true;
      results.push(this.result(active, contact, this.outcomeFor(contact), now, { expired: true }));
    }
    const observedPen = [...active.contacts.values()].some((contact) => contact.pointerType === "pen");
    if (!observedPen) {
      results.push({
        armId: active.armId,
        correlationId: null,
        outcome: "post-ui-probe-expired-no-pen",
        elapsedMs: Math.max(0, now - active.armedAt),
        pointerDownCount: active.pointerDownCount,
        observedPointerTypes: [...active.observedPointerTypes],
        contactCount: active.contacts.size,
        contact: null,
        details: {
          ...this.contextDetails(active),
          expired: true,
          noPenContact: true,
          observedPointerTypes: [...active.observedPointerTypes]
        }
      });
    }
    return results;
  }

  private outcomeFor(contact: ProbeContact): PostUiProbeOutcome {
    if (contact.pointerType !== "pen") return "post-ui-probe-touch-contact";
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
      outcome,
      elapsedMs: Math.max(0, now - active.armedAt),
      pointerDownCount: active.pointerDownCount,
      observedPointerTypes: [...active.observedPointerTypes],
      contactCount: active.contacts.size,
      contact: this.summary(contact, now),
      details: { ...this.contextDetails(active), ...contact.details, ...details }
    };
  }

  private contextDetails(active: ActiveProbe): Record<string, unknown> {
    return {
      sessionId: active.context.sessionId,
      viewerGeneration: active.context.viewerGeneration,
      pageGeneration: active.context.pageGeneration,
      mountedPages: active.context.mountedPages,
      documentPath: active.context.documentPath,
      transition: active.context.transition
    };
  }

  private summary(contact: ProbeContact, now: number): PostUiProbeContactSummary {
    return {
      armId: contact.armId,
      correlationId: contact.correlationId,
      contactNumber: contact.contactNumber,
      pointerId: contact.pointerId,
      pointerType: contact.pointerType,
      startedAt: contact.startedAt,
      elapsedMs: Math.max(0, now - contact.startedAt),
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
