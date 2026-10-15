/** Bounded input correlation for the first contacts after zoom settles. */

export const POST_ZOOM_CONTACT_LIMIT = 3;
export const POST_ZOOM_REJECTED_CONTACT_LIMIT = 8;
export const POST_ZOOM_WINDOW_MS = 8_000;
export const POST_ZOOM_RING_LIMIT = 30;

export type StylusIdentity = "established" | "unknown" | "absent";

export type PostZoomFailureClass =
  | "post-zoom-stylus-identity-not-established"
  | "post-zoom-router-not-received"
  | "post-zoom-router-rejected"
  | "post-zoom-stale-page-binding"
  | "post-zoom-input-owner-mismatch"
  | "post-zoom-fallback-rejected"
  | "post-zoom-native-pan-won"
  | "post-zoom-pointer-capture-stale";

export interface PostZoomLifecycleEvent {
  at: string;
  event: string;
  details: Record<string, unknown>;
}

export interface PostZoomContactObservation {
  overAnnotatablePage: boolean;
  stylusIdentity: StylusIdentity;
  physicalContactId: string;
  strokeStarted: boolean;
  routerReceived: boolean;
  routerRejected: boolean;
  stalePageBinding: boolean;
  inputOwnerMismatch: boolean;
  fallbackRejected: boolean;
  nativePanWon: boolean;
  pointerCaptureStale: boolean;
}

/** One settle-time recovery, so a later device log can attribute the next pointer type. */
export const POST_ZOOM_CAPTURE_RECOVERY = "release-annotation-pointer-captures";
export const ZOOM_BURST_STUCK_MS = 2_000;

export interface ZoomBurstWatchInput {
  now: number;
  lastZoomSignalAt: number;
  zoomSettleTimerArmed: boolean;
  zoomSettleTimerDueAt: number;
  liveInk: boolean;
}

/** Keep a quiet, idle burst from staying open after its settle callback was lost. */
export function decideZoomBurstWatchdog(input: ZoomBurstWatchInput): { action: "recover" | "wait"; reason: string } {
  if (input.liveInk) return { action: "wait", reason: "live-ink" };
  if (input.now - input.lastZoomSignalAt <= ZOOM_BURST_STUCK_MS) return { action: "wait", reason: "recent-zoom-signal" };
  if (input.zoomSettleTimerArmed && input.zoomSettleTimerDueAt > input.now) return { action: "wait", reason: "settle-timer-pending" };
  if (input.zoomSettleTimerArmed) return { action: "recover", reason: "settle-timer-lost" };
  return { action: "recover", reason: "no-continuation" };
}

export interface StylusIdentityRegression {
  event: "post-zoom-stylus-identity-regression";
  zoomBurstId: string;
  preZoomPointerType: "pen";
  preZoomPointerEventPenSeen: true;
  postZoomPointerType: string;
  postZoomPointerEventPenSeen: false;
  postZoomStylusIdentity: StylusIdentity;
  sameSession: true;
  samePageMountGeneration: boolean | null;
  sameRouterGeneration: boolean | null;
  physicalToolClaimed: boolean;
  recoveryExperiment: string | null;
}

/**
 * Compare the last successful pen PointerEvent with a later page contact that
 * claims stylus identity but has no browser stylus evidence. Returns null unless
 * that browser-property change is real.
 */
export function stylusIdentityRegression(input: {
  zoomBurstId: string | null;
  preZoomPointerType: unknown;
  preZoomPointerEventPenSeen: unknown;
  postZoomPointerType: string | null;
  postZoomPointerEventPenSeen: boolean;
  postZoomStylusIdentity: StylusIdentity;
  physicalToolClaimed?: boolean;
  strokeStarted: boolean;
  preZoomPageMountGeneration: number | null;
  postZoomPageMountGeneration: number | null;
  preZoomRouterGeneration: number | null;
  postZoomRouterGeneration: number | null;
  recoveryExperiment: string | null;
}): StylusIdentityRegression | null {
  if (!input.zoomBurstId || input.strokeStarted) return null;
  if (input.physicalToolClaimed !== true) return null;
  if (input.preZoomPointerType !== "pen" || input.preZoomPointerEventPenSeen !== true) return null;
  if (input.postZoomPointerEventPenSeen || input.postZoomStylusIdentity === "established") return null;
  const postZoomPointerType = input.postZoomPointerType ?? "unknown";
  if (postZoomPointerType === "pen") return null;
  return {
    event: "post-zoom-stylus-identity-regression",
    zoomBurstId: input.zoomBurstId,
    preZoomPointerType: "pen",
    preZoomPointerEventPenSeen: true,
    postZoomPointerType,
    postZoomPointerEventPenSeen: false,
    postZoomStylusIdentity: input.postZoomStylusIdentity,
    sameSession: true,
    samePageMountGeneration: input.preZoomPageMountGeneration !== null && input.postZoomPageMountGeneration !== null
      ? input.preZoomPageMountGeneration === input.postZoomPageMountGeneration
      : null,
    sameRouterGeneration: input.preZoomRouterGeneration !== null && input.postZoomRouterGeneration !== null
      ? input.preZoomRouterGeneration === input.postZoomRouterGeneration
      : null,
    physicalToolClaimed: true,
    recoveryExperiment: input.recoveryExperiment
  };
}

export interface LastZoomDiagnosis {
  zoomBurstId: string | null;
  beganAt: string | null;
  settledAt: string | null;
  scaleBefore: number | null;
  scaleAfter: number | null;
  settleSnapshot: Record<string, unknown> | null;
  pendingMobileScrollRemount: boolean | null;
  firstPostZoomContacts: Array<Record<string, unknown>>;
  rejectedPostZoomContacts: Array<Record<string, unknown>>;
  lastPostZoomAnomaly: Omit<PostZoomAnomaly, "lifecycle"> | null;
  anomalyLifecycle: PostZoomLifecycleEvent[];
  stylusIdentityRegression: StylusIdentityRegression | null;
  recoveryExperiment: string | null;
  capturesReleased: number;
  burstActivity: Record<string, unknown> | null;
}

export function validPhysicalDisplacementPx(contact: {
  maxDisplacementPx: number;
  firstPoint: { x: number; y: number } | null;
  lastValidPoint: { x: number; y: number } | null;
  terminalPointRejectReason: string | null;
}): number {
  if (contact.terminalPointRejectReason) {
    if (!contact.firstPoint || !contact.lastValidPoint) return 0;
    return Math.hypot(contact.lastValidPoint.x - contact.firstPoint.x, contact.lastValidPoint.y - contact.firstPoint.y);
  }
  return contact.maxDisplacementPx;
}

export interface PostZoomAnomaly {
  event: "post-zoom-input-anomaly";
  reason: "post-zoom-contact-not-routed";
  classification: PostZoomFailureClass;
  zoomBurstId: string;
  physicalContactId: string;
  stylusIdentity: StylusIdentity;
  postZoomContactIndex: number;
  lifecycle: PostZoomLifecycleEvent[];
}

export function stylusIdentityFromClassification(input: {
  pointerEventPenSeen: boolean;
  classification: string;
}): StylusIdentity {
  if (input.pointerEventPenSeen || input.classification === "pen-only") return "established";
  if (input.classification === "paired" && input.pointerEventPenSeen) return "established";
  if (input.classification === "unknown") return "unknown";
  return "absent";
}

/** First broken stage. Finger contacts (identity absent) are not Pencil failures. */
export function classifyPostZoomFailure(contact: PostZoomContactObservation): PostZoomFailureClass | null {
  if (!contact.overAnnotatablePage || contact.strokeStarted) return null;
  if (contact.stylusIdentity === "absent") return null;
  if (contact.stylusIdentity !== "established") return "post-zoom-stylus-identity-not-established";
  if (contact.stalePageBinding) return "post-zoom-stale-page-binding";
  if (contact.inputOwnerMismatch) return "post-zoom-input-owner-mismatch";
  if (!contact.routerReceived) return "post-zoom-router-not-received";
  if (contact.routerRejected) return "post-zoom-router-rejected";
  if (contact.fallbackRejected) return "post-zoom-fallback-rejected";
  if (contact.pointerCaptureStale) return "post-zoom-pointer-capture-stale";
  if (contact.nativePanWon) return "post-zoom-native-pan-won";
  return "post-zoom-router-not-received";
}

/** Neutral diagnosis when the browser never established a stylus for a drawing-tool contact. */
export function postZoomFinalDisposition(input: {
  penToolActive: boolean;
  stylusIdentity: StylusIdentity;
  strokeStarted: boolean;
  anomalyClassification: PostZoomFailureClass | null;
}): { finalDisposition: string; possibleFinger: boolean } {
  if (input.strokeStarted) return { finalDisposition: "stroke-started", possibleFinger: false };
  if (input.penToolActive && input.stylusIdentity !== "established") {
    return { finalDisposition: "post-zoom-contact-no-stylus-identity", possibleFinger: true };
  }
  if (input.anomalyClassification) {
    return { finalDisposition: input.anomalyClassification, possibleFinger: false };
  }
  return { finalDisposition: "observed", possibleFinger: false };
}

/** A handled pointer only blocks the router generation that claimed it. */
export function pointerHandledForGeneration(
  handled: ReadonlyMap<number, number>,
  pointerId: number,
  generation: number
): boolean {
  return handled.get(pointerId) === generation;
}

export class PostZoomInputTrace {
  private serial = 0;
  private activeId: string | null = null;
  private settledId: string | null = null;
  private settledAt = 0;
  private contactsLogged = 0;
  private correlationOpen = false;
  private readonly admitted = new Map<string, {
    zoomBurstId: string;
    postZoomContactIndex: number;
    admittedAt: number;
    terminal: boolean;
  }>();
  private readonly anomalyContacts = new Set<string>();
  private readonly ring: PostZoomLifecycleEvent[] = [];
  private readonly diagnosisState: LastZoomDiagnosis = {
    zoomBurstId: null,
    beganAt: null,
    settledAt: null,
    scaleBefore: null,
    scaleAfter: null,
    settleSnapshot: null,
    pendingMobileScrollRemount: null,
    firstPostZoomContacts: [],
    rejectedPostZoomContacts: [],
    lastPostZoomAnomaly: null,
    anomalyLifecycle: [],
    stylusIdentityRegression: null,
    recoveryExperiment: null,
    capturesReleased: 0,
    burstActivity: null
  };

  currentBurstId(): string | null {
    return this.activeId ?? (this.correlationOpen ? this.settledId : null);
  }

  begin(at = new Date().toISOString()): string {
    this.serial += 1;
    this.activeId = `zoom-${this.serial}`;
    this.settledId = null;
    this.settledAt = 0;
    this.contactsLogged = 0;
    this.correlationOpen = false;
    this.admitted.clear();
    this.anomalyContacts.clear();
    this.diagnosisState.zoomBurstId = this.activeId;
    this.diagnosisState.beganAt = at;
    this.diagnosisState.settledAt = null;
    this.diagnosisState.scaleBefore = null;
    this.diagnosisState.scaleAfter = null;
    this.diagnosisState.settleSnapshot = null;
    this.diagnosisState.pendingMobileScrollRemount = null;
    this.diagnosisState.firstPostZoomContacts = [];
    this.diagnosisState.rejectedPostZoomContacts = [];
    this.diagnosisState.lastPostZoomAnomaly = null;
    this.diagnosisState.anomalyLifecycle = [];
    this.diagnosisState.stylusIdentityRegression = null;
    this.diagnosisState.recoveryExperiment = null;
    this.diagnosisState.capturesReleased = 0;
    this.diagnosisState.burstActivity = null;
    this.remember("zoom-begin", { zoomBurstId: this.activeId }, at);
    return this.activeId;
  }

  retainedContact(physicalContactId: string): Record<string, unknown> | null {
    const contact = this.diagnosisState.firstPostZoomContacts.find(
      (entry) => entry.physicalContactId === physicalContactId
    );
    return contact ? { ...contact } : null;
  }

  /** Compact diagnosis kept after the ordinary log ring scrolls away. */
  diagnosis(): LastZoomDiagnosis {
    return {
      ...this.diagnosisState,
      settleSnapshot: this.diagnosisState.settleSnapshot ? { ...this.diagnosisState.settleSnapshot } : null,
      firstPostZoomContacts: this.diagnosisState.firstPostZoomContacts.map((contact) => ({ ...contact })),
      rejectedPostZoomContacts: this.diagnosisState.rejectedPostZoomContacts.map((contact) => ({ ...contact })),
      lastPostZoomAnomaly: this.diagnosisState.lastPostZoomAnomaly ? { ...this.diagnosisState.lastPostZoomAnomaly } : null,
      anomalyLifecycle: this.diagnosisState.anomalyLifecycle.map((event) => ({ ...event, details: { ...event.details } })),
      stylusIdentityRegression: this.diagnosisState.stylusIdentityRegression
        ? { ...this.diagnosisState.stylusIdentityRegression }
        : null,
      burstActivity: this.diagnosisState.burstActivity ? { ...this.diagnosisState.burstActivity } : null
    };
  }

  isBurstOpen(): boolean {
    return this.activeId !== null;
  }

  noteBurstActivity(details: Record<string, unknown>): void {
    this.diagnosisState.burstActivity = { ...(this.diagnosisState.burstActivity ?? {}), ...details };
  }

  noteCaptureRecovery(experiment: string, capturesReleased: number): void {
    this.diagnosisState.recoveryExperiment = experiment;
    this.diagnosisState.capturesReleased = capturesReleased;
  }

  /** First browser-identity regression for this burst. Later contacts stay on the diagnosis only. */
  noteStylusIdentityRegression(regression: StylusIdentityRegression | null): StylusIdentityRegression | null {
    if (!regression || this.diagnosisState.stylusIdentityRegression) return null;
    this.diagnosisState.stylusIdentityRegression = { ...regression };
    return this.diagnosisState.stylusIdentityRegression;
  }

  remember(event: string, details: Record<string, unknown> = {}, at = new Date().toISOString()): void {
    const zoomBurstId = this.currentBurstId();
    this.ring.push({
      at,
      event,
      details: { ...(zoomBurstId ? { zoomBurstId } : {}), ...details }
    });
    if (this.ring.length > POST_ZOOM_RING_LIMIT) {
      this.ring.splice(0, this.ring.length - POST_ZOOM_RING_LIMIT);
    }
    if (event === "pending-mobile-remount" || event === "pending-mobile-remount-cleared") {
      this.diagnosisState.pendingMobileScrollRemount = details.pendingMobileScrollRemount === true;
    }
    if (event === "post-zoom-contact" && typeof details.physicalContactId === "string") {
      const existing = this.diagnosisState.firstPostZoomContacts.find(
        (contact) => contact.physicalContactId === details.physicalContactId
      );
      if (existing) Object.assign(existing, details);
      else if (this.diagnosisState.firstPostZoomContacts.length < POST_ZOOM_CONTACT_LIMIT) {
        this.diagnosisState.firstPostZoomContacts.push({ ...details });
      }
    }
  }

  settle(atMs: number, snapshot: Record<string, unknown> = {}): string | null {
    if (!this.activeId) return this.settledId;
    this.settledId = this.activeId;
    this.settledAt = atMs;
    this.contactsLogged = 0;
    this.correlationOpen = true;
    this.admitted.clear();
    this.anomalyContacts.clear();
    this.diagnosisState.zoomBurstId = this.settledId;
    this.diagnosisState.settledAt = new Date(atMs).toISOString();
    this.diagnosisState.scaleBefore = typeof snapshot.scaleBefore === "number" ? snapshot.scaleBefore : null;
    this.diagnosisState.scaleAfter = typeof snapshot.scaleAfter === "number" ? snapshot.scaleAfter : null;
    if (typeof snapshot.pendingMobileScrollRemount === "boolean") {
      this.diagnosisState.pendingMobileScrollRemount = snapshot.pendingMobileScrollRemount;
    }
    this.diagnosisState.settleSnapshot = { ...snapshot };
    this.remember("zoom-settle", { zoomBurstId: this.settledId, ...snapshot });
    this.activeId = null;
    return this.settledId;
  }

  /** UI chrome that overlapped a page rectangle. Does not consume a post-zoom slot. */
  noteRejectedPageContact(contact: Record<string, unknown>): void {
    if (this.diagnosisState.rejectedPostZoomContacts.length >= POST_ZOOM_REJECTED_CONTACT_LIMIT) return;
    this.diagnosisState.rejectedPostZoomContacts.push({ ...contact });
  }

  /** Index of a page-overlapping contact inside the post-settle window, or null. */
  notePageContact(
    atMs: number,
    overAnnotatablePage: boolean,
    physicalContactId = `admitted-${this.contactsLogged + 1}`
  ): { zoomBurstId: string; postZoomContactIndex: number; admittedAt: number; postZoomWindowAgeMs: number } | null {
    this.expireCorrelation(atMs);
    if (!this.correlationOpen || !this.settledId || !overAnnotatablePage) return null;
    const existing = this.admitted.get(physicalContactId);
    if (existing) {
      return {
        zoomBurstId: existing.zoomBurstId,
        postZoomContactIndex: existing.postZoomContactIndex,
        admittedAt: existing.admittedAt,
        postZoomWindowAgeMs: atMs - this.settledAt
      };
    }
    if (this.contactsLogged >= POST_ZOOM_CONTACT_LIMIT) return null;
    this.contactsLogged += 1;
    this.admitted.set(physicalContactId, {
      zoomBurstId: this.settledId,
      postZoomContactIndex: this.contactsLogged,
      admittedAt: atMs,
      terminal: false
    });
    return {
      zoomBurstId: this.settledId,
      postZoomContactIndex: this.contactsLogged,
      admittedAt: atMs,
      postZoomWindowAgeMs: atMs - this.settledAt
    };
  }

  /** An admitted contact has finished. Correlation ends once all three have finished. */
  completeAdmittedContact(physicalContactId: string, atMs: number): void {
    this.expireCorrelation(atMs);
    const admitted = this.admitted.get(physicalContactId);
    if (!admitted || !this.correlationOpen) return;
    admitted.terminal = true;
    if (
      this.admitted.size >= POST_ZOOM_CONTACT_LIMIT
      && [...this.admitted.values()].every((entry) => entry.terminal)
    ) {
      this.endCorrelation();
    }
  }

  anomaly(contact: PostZoomContactObservation, atMs?: number): PostZoomAnomaly | null {
    const admitted = this.admitted.get(contact.physicalContactId);
    if (!admitted || !this.correlationOpen || !this.settledId) return null;
    const time = atMs ?? admitted.admittedAt;
    this.expireCorrelation(time);
    if (!this.correlationOpen || this.anomalyContacts.has(contact.physicalContactId)) return null;
    const classification = classifyPostZoomFailure(contact);
    if (!classification) {
      this.completeAdmittedContact(contact.physicalContactId, time);
      return null;
    }
    this.anomalyContacts.add(contact.physicalContactId);
    admitted.terminal = true;
    const zoomBurstId = admitted.zoomBurstId;
    const postZoomContactIndex = admitted.postZoomContactIndex;
    const payload: PostZoomAnomaly = {
      event: "post-zoom-input-anomaly",
      reason: "post-zoom-contact-not-routed",
      classification,
      zoomBurstId,
      physicalContactId: contact.physicalContactId,
      stylusIdentity: contact.stylusIdentity,
      postZoomContactIndex,
      lifecycle: this.ring.slice()
    };
    this.diagnosisState.lastPostZoomAnomaly = {
      event: payload.event,
      reason: payload.reason,
      classification: payload.classification,
      zoomBurstId: payload.zoomBurstId,
      physicalContactId: payload.physicalContactId,
      stylusIdentity: payload.stylusIdentity,
      postZoomContactIndex: payload.postZoomContactIndex
    };
    this.diagnosisState.anomalyLifecycle = payload.lifecycle.map((event) => ({ ...event, details: { ...event.details } }));
    this.remember("post-zoom-input-anomaly", {
      reason: payload.reason,
      classification,
      physicalContactId: contact.physicalContactId
    });
    this.completeAdmittedContact(contact.physicalContactId, time);
    return payload;
  }

  private expireCorrelation(atMs: number): void {
    if (!this.correlationOpen || !this.settledId) return;
    if (atMs - this.settledAt <= POST_ZOOM_WINDOW_MS) return;
    this.endCorrelation();
  }

  /** Stop accepting new post-zoom contacts. The completed diagnosis stays for Copy Logs. */
  private endCorrelation(): void {
    this.correlationOpen = false;
  }
}
