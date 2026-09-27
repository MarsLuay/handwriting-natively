/** Bounded pinch/zoom correlation for the first contacts after settle. */

export const POST_ZOOM_CONTACT_LIMIT = 3;
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
export const POST_ZOOM_GESTURE_RECOVERY = "wait-for-all-pinch-contacts-to-fully-terminate-before-post-zoom-enable";
export const PINCH_CLEANUP_MAX_WAIT_MS = 800;
export const ZOOM_BURST_STUCK_MS = 2_000;

export interface ZoomBurstWatchInput {
  now: number;
  lastZoomSignalAt: number;
  zoomSettleTimerArmed: boolean;
  zoomSettleTimerDueAt: number;
  pinchCleanupFrameArmed: boolean;
  activePinchPointers: number;
  activePinchTouches: number;
  liveInk: boolean;
  /** IDs that never ended should not keep the burst open after the cleanup timeout. */
  gestureCleanupTimedOut?: boolean;
}

/** Keep a quiet, idle burst from staying open after its settle callback was lost. */
export function decideZoomBurstWatchdog(input: ZoomBurstWatchInput): { action: "recover" | "wait"; reason: string } {
  const stalePinch = input.gestureCleanupTimedOut === true;
  if (input.liveInk) return { action: "wait", reason: "live-ink" };
  if (!stalePinch && (input.activePinchPointers > 0 || input.activePinchTouches > 0)) {
    return { action: "wait", reason: "active-pinch" };
  }
  if (input.now - input.lastZoomSignalAt <= ZOOM_BURST_STUCK_MS) return { action: "wait", reason: "recent-zoom-signal" };
  if (input.pinchCleanupFrameArmed && !stalePinch) return { action: "wait", reason: "pinch-cleanup-frame" };
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
  /** Browser properties only. This does not claim the physical tool was Pencil. */
  physicalToolClaimed: false;
  recoveryExperiment: string | null;
}

/**
 * Compare the last successful pen PointerEvent with a later page contact that
 * has no stylus evidence. Returns null unless that browser-property change is real.
 */
export function stylusIdentityRegression(input: {
  zoomBurstId: string | null;
  preZoomPointerType: unknown;
  preZoomPointerEventPenSeen: unknown;
  postZoomPointerType: string | null;
  postZoomPointerEventPenSeen: boolean;
  postZoomStylusIdentity: StylusIdentity;
  strokeStarted: boolean;
  preZoomPageMountGeneration: number | null;
  postZoomPageMountGeneration: number | null;
  preZoomRouterGeneration: number | null;
  postZoomRouterGeneration: number | null;
  recoveryExperiment: string | null;
}): StylusIdentityRegression | null {
  if (!input.zoomBurstId || input.strokeStarted) return null;
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
    physicalToolClaimed: false,
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
  lastPostZoomAnomaly: Omit<PostZoomAnomaly, "lifecycle"> | null;
  anomalyLifecycle: PostZoomLifecycleEvent[];
  stylusIdentityRegression: StylusIdentityRegression | null;
  recoveryExperiment: string | null;
  capturesReleased: number;
  gestureCleanup: Record<string, unknown> | null;
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
    lastPostZoomAnomaly: null,
    anomalyLifecycle: [],
    stylusIdentityRegression: null,
    recoveryExperiment: null,
    capturesReleased: 0,
    gestureCleanup: null,
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
    this.diagnosisState.lastPostZoomAnomaly = null;
    this.diagnosisState.anomalyLifecycle = [];
    this.diagnosisState.stylusIdentityRegression = null;
    this.diagnosisState.recoveryExperiment = null;
    this.diagnosisState.capturesReleased = 0;
    this.diagnosisState.gestureCleanup = null;
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
      lastPostZoomAnomaly: this.diagnosisState.lastPostZoomAnomaly ? { ...this.diagnosisState.lastPostZoomAnomaly } : null,
      anomalyLifecycle: this.diagnosisState.anomalyLifecycle.map((event) => ({ ...event, details: { ...event.details } })),
      stylusIdentityRegression: this.diagnosisState.stylusIdentityRegression
        ? { ...this.diagnosisState.stylusIdentityRegression }
        : null,
      gestureCleanup: this.diagnosisState.gestureCleanup ? { ...this.diagnosisState.gestureCleanup } : null,
      burstActivity: this.diagnosisState.burstActivity ? { ...this.diagnosisState.burstActivity } : null
    };
  }

  isBurstOpen(): boolean {
    return this.activeId !== null;
  }

  noteBurstActivity(details: Record<string, unknown>): void {
    this.diagnosisState.burstActivity = { ...(this.diagnosisState.burstActivity ?? {}), ...details };
  }

  noteGestureCleanup(details: Record<string, unknown>): void {
    this.diagnosisState.recoveryExperiment = POST_ZOOM_GESTURE_RECOVERY;
    this.diagnosisState.gestureCleanup = { ...details, recoveryExperiment: POST_ZOOM_GESTURE_RECOVERY };
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

interface PinchPointerState {
  terminal: boolean;
  lostCapture: boolean;
  nativeTerminalSeen: boolean;
  retireReason: PinchPointerRetireReason | null;
}

export type PinchPointerRetireReason =
  | "pointerup"
  | "pointercancel"
  | "lostpointercapture"
  | "paired-touch-ended"
  | "active-set-reconciled"
  | "stale-after-paired-stream-ended";

export interface StalePinchPointerReconcile {
  event: "stale-pinch-pointer-reconciled";
  pointerId: number;
  pairedTouchIdentifier: number;
  nativePointerTerminalSeen: boolean;
  pairedTouchTerminal: "touchend" | "touchcancel" | "active-set-reconciled";
  remainingActiveTouches: number[];
  reason: "paired-touch-ended" | "active-set-reconciled" | "stale-after-paired-stream-ended";
  pointerLastSeenAgeMs: number | null;
}

export interface PinchCleanupReport {
  pinchPointerIds: number[];
  pinchTouchIdentifiers: number[];
  terminalPointerIds: number[];
  terminalTouchIdentifiers: number[];
  lostCapturePointerIds: number[];
  orphanedPinchPointerIds: number[];
  pairedTouchTerminalForPointerIds: number[];
  pointerRetiredByCrossStreamReconciliation: number[];
  pointerRetireReason: Record<string, string>;
  pointerLastSeenAgeMs: Record<string, number | null>;
  activePinchPointersAtSettle: number[];
  activePinchTouchesAtSettle: number[];
  settleDeferredForGestureCleanup: boolean;
  gestureCleanupWaitMs: number;
  postCleanupAnimationFrames: number;
  gestureCleanupTimedOut: boolean;
  quiescent: boolean;
}

/** Touch contacts in the zoom burst. Pen and mouse are not pinch participants. */
export interface StalePinchPrune {
  event: "stale-pinch-contact-pruned";
  id: number;
  stream: "pointer" | "touch";
  lastSeenAt: number | null;
  ageMs: number | null;
  reason: "touch-list-all-clear" | "not-in-current-active-set" | "stale-before-burst";
}

export interface PinchBurstSeed {
  seededPinchPointerIds: number[];
  seededPinchTouchIdentifiers: number[];
  prunedBeforeBurstPointerIds: number[];
  prunedBeforeBurstTouchIdentifiers: number[];
  pruned: StalePinchPrune[];
}

export class PinchGestureCleanup {
  private tracking = false;
  private deferredAt: number | null = null;
  private evaluateCount = 0;
  private animationFrames = 0;
  private timedOut = false;
  private lastPinchEventAt: number | null = null;
  private readonly pointers = new Map<number, PinchPointerState>();
  private readonly touches = new Map<number, { terminal: boolean }>();
  private readonly pinchPointers = new Set<number>();
  private readonly pinchTouches = new Set<number>();
  private readonly activePointerIds = new Set<number>();
  private readonly activeTouchIdentifiers = new Set<number>();
  private readonly stylusAssociated = new Set<number>();
  private readonly pointerSeenAt = new Map<number, number>();
  private readonly touchSeenAt = new Map<number, number>();
  private readonly pointerToTouch = new Map<number, number>();
  private readonly touchToPointer = new Map<number, number>();
  private readonly livePenPointerIds = new Set<number>();
  private readonly pointerReconciliations: StalePinchPointerReconcile[] = [];
  private loggedPointerReconciliations = 0;
  private lastSeed: PinchBurstSeed = {
    seededPinchPointerIds: [],
    seededPinchTouchIdentifiers: [],
    prunedBeforeBurstPointerIds: [],
    prunedBeforeBurstTouchIdentifiers: [],
    pruned: []
  };

  beginBurst(now = Date.now()): PinchBurstSeed {
    this.tracking = true;
    this.deferredAt = null;
    this.animationFrames = 0;
    this.evaluateCount = 0;
    this.timedOut = false;
    const pruned = [
      ...this.pruneInactive("pointer", this.pointers, this.activePointerIds, now),
      ...this.pruneInactive("touch", this.touches, this.activeTouchIdentifiers, now)
    ];
    this.pinchPointers.clear();
    this.pinchTouches.clear();
    for (const id of this.activePointerIds) this.pinchPointers.add(id);
    for (const id of this.activeTouchIdentifiers) {
      if (!this.stylusAssociated.has(id)) this.pinchTouches.add(id);
    }
    this.lastSeed = {
      seededPinchPointerIds: [...this.pinchPointers],
      seededPinchTouchIdentifiers: [...this.pinchTouches],
      prunedBeforeBurstPointerIds: pruned.filter((entry) => entry.stream === "pointer").map((entry) => entry.id),
      prunedBeforeBurstTouchIdentifiers: pruned.filter((entry) => entry.stream === "touch").map((entry) => entry.id),
      pruned
    };
    return this.lastSeed;
  }

  seedSummary(): PinchBurstSeed {
    return {
      ...this.lastSeed,
      pruned: this.lastSeed.pruned.map((entry) => ({ ...entry }))
    };
  }

  /** Called only after the physical-contact collector pairs this touch with a pen pointer. */
  excludeStylusTouch(touchIdentifier: number): boolean {
    const added = !this.stylusAssociated.has(touchIdentifier);
    this.stylusAssociated.add(touchIdentifier);
    this.activeTouchIdentifiers.delete(touchIdentifier);
    this.pinchTouches.delete(touchIdentifier);
    return added;
  }

  releaseStylusTouch(touchIdentifier: number): void {
    this.stylusAssociated.delete(touchIdentifier);
  }

  associationState(): {
    stylusAssociatedTouchIdentifiers: number[];
    excludedStylusTouchIdentifiers: number[];
    pinchEligibleTouchIdentifiers: number[];
  } {
    return {
      stylusAssociatedTouchIdentifiers: [...this.stylusAssociated],
      excludedStylusTouchIdentifiers: [...this.stylusAssociated],
      pinchEligibleTouchIdentifiers: [...this.activeTouchIdentifiers].filter((id) => !this.stylusAssociated.has(id))
    };
  }

  endBurst(): void {
    this.tracking = false;
  }

  /** Deterministic pointer/touch pair. Same id or a one-to-one contact, never geometry. */
  associate(pointerId: number, touchIdentifier: number): void {
    this.pointerToTouch.set(pointerId, touchIdentifier);
    this.touchToPointer.set(touchIdentifier, pointerId);
  }

  noteLivePens(pointerIds: readonly number[]): void {
    this.livePenPointerIds.clear();
    for (const id of pointerIds) this.livePenPointerIds.add(id);
  }

  consumePointerReconciliations(): StalePinchPointerReconcile[] {
    const fresh = this.pointerReconciliations.slice(this.loggedPointerReconciliations);
    this.loggedPointerReconciliations = this.pointerReconciliations.length;
    return fresh.map((entry) => ({ ...entry, remainingActiveTouches: [...entry.remainingActiveTouches] }));
  }

  reconciliationState(): {
    orphanedPinchPointerIds: number[];
    pairedTouchTerminalForPointerIds: number[];
    pointerRetiredByCrossStreamReconciliation: number[];
    pointerRetireReason: Record<string, string>;
    pointerLastSeenAgeMs: Record<string, number | null>;
  } {
    const retired = this.pointerReconciliations;
    const pointerRetireReason: Record<string, string> = {};
    const pointerLastSeenAgeMs: Record<string, number | null> = {};
    for (const entry of retired) {
      pointerRetireReason[String(entry.pointerId)] = entry.reason;
      pointerLastSeenAgeMs[String(entry.pointerId)] = entry.pointerLastSeenAgeMs;
    }
    const ids = retired.map((entry) => entry.pointerId);
    return {
      orphanedPinchPointerIds: ids.filter((id) => this.pointers.get(id)?.nativeTerminalSeen !== true),
      pairedTouchTerminalForPointerIds: ids,
      pointerRetiredByCrossStreamReconciliation: ids,
      pointerRetireReason,
      pointerLastSeenAgeMs
    };
  }

  /** Drop touches the browser no longer lists, and clear everything when no touches remain. */
  reconcileTouches(eventType: string, changedIds: readonly number[], activeIds: readonly number[], now = Date.now()): StalePinchPrune[] {
    for (const id of changedIds) {
      this.touchSeenAt.set(id, now);
      this.noteSameIdPair(id);
    }
    if (eventType === "touchend" || eventType === "touchcancel") {
      for (const id of changedIds) {
        this.finishTouch(id);
        this.reconcilePairedPointer(id, eventType, now);
      }
    }
    if (activeIds.length === 0) {
      return this.clearActiveTouches(
        "touch-list-all-clear",
        now,
        eventType === "touchend" || eventType === "touchcancel" ? eventType : "active-set-reconciled"
      );
    }
    const live = new Set(activeIds);
    for (const id of activeIds) {
      if (this.stylusAssociated.has(id)) {
        this.activeTouchIdentifiers.delete(id);
        this.pinchTouches.delete(id);
        continue;
      }
      this.activeTouchIdentifiers.add(id);
      this.touches.set(id, { terminal: false });
      this.touchSeenAt.set(id, now);
      this.noteSameIdPair(id);
      if (this.tracking) this.pinchTouches.add(id);
    }
    const pruned: StalePinchPrune[] = [];
    for (const id of [...this.activeTouchIdentifiers]) {
      if (live.has(id)) continue;
      pruned.push(this.pruneTouch(id, "not-in-current-active-set", now));
      this.reconcilePairedPointer(id, "active-set-reconciled", now);
    }
    return pruned;
  }

  clearActiveTouches(
    reason: StalePinchPrune["reason"] = "touch-list-all-clear",
    now = Date.now(),
    touchTerminal: "touchend" | "touchcancel" | "active-set-reconciled" = "active-set-reconciled"
  ): StalePinchPrune[] {
    const ids = [...this.activeTouchIdentifiers];
    const pruned = ids.map((id) => this.pruneTouch(id, reason, now));
    for (const id of ids) this.reconcilePairedPointer(id, touchTerminal, now);
    this.activeTouchIdentifiers.clear();
    if (!this.tracking) this.pinchTouches.clear();
    return pruned;
  }

  observePointer(pointerId: number, eventType: string, pointerType: string, now = Date.now()): void {
    if (pointerType === "pen" || pointerType === "mouse") return;
    const current = this.pointers.get(pointerId) ?? this.freshPointer();
    this.pointerSeenAt.set(pointerId, now);
    if (eventType === "pointerdown") {
      this.activePointerIds.add(pointerId);
      this.pointers.set(pointerId, this.freshPointer());
    } else {
      if (eventType === "pointerup" || eventType === "pointercancel") {
        current.terminal = true;
        current.nativeTerminalSeen = true;
        current.retireReason = eventType;
        this.activePointerIds.delete(pointerId);
        this.retirePairedTouch(pointerId);
      }
      if (eventType === "lostpointercapture") {
        current.lostCapture = true;
        if (!current.retireReason) current.retireReason = "lostpointercapture";
      }
      this.pointers.set(pointerId, current);
    }
    this.noteSameIdPair(pointerId);
    if (this.tracking && this.activePointerIds.has(pointerId)) this.pinchPointers.add(pointerId);
    if (this.tracking || this.pinchPointers.has(pointerId)) this.lastPinchEventAt = now;
  }

  observeTouch(identifier: number, eventType: string, now = Date.now()): void {
    this.touchSeenAt.set(identifier, now);
    const current = this.touches.get(identifier) ?? { terminal: false };
    if (eventType === "touchstart") {
      this.activeTouchIdentifiers.add(identifier);
      this.touches.set(identifier, { terminal: false });
    } else {
      if (eventType === "touchend" || eventType === "touchcancel") {
        current.terminal = true;
        this.activeTouchIdentifiers.delete(identifier);
      }
      this.touches.set(identifier, current);
    }
    this.noteSameIdPair(identifier);
    if (eventType === "touchend" || eventType === "touchcancel") this.reconcilePairedPointer(identifier, eventType, now);
    if (this.tracking && this.activeTouchIdentifiers.has(identifier)) this.pinchTouches.add(identifier);
    if (this.tracking || this.pinchTouches.has(identifier)) this.lastPinchEventAt = now;
  }

  private freshPointer(): PinchPointerState {
    return { terminal: false, lostCapture: false, nativeTerminalSeen: false, retireReason: null };
  }

  private noteSameIdPair(id: number): void {
    if (this.pointers.has(id) && (this.touches.has(id) || this.activeTouchIdentifiers.has(id))) this.associate(id, id);
  }

  private reconcilePairedPointer(
    touchIdentifier: number,
    touchTerminal: "touchend" | "touchcancel" | "active-set-reconciled",
    now: number
  ): void {
    const pointerId = this.touchToPointer.get(touchIdentifier);
    if (pointerId == null || this.pointerToTouch.get(pointerId) !== touchIdentifier) return;
    if (this.livePenPointerIds.has(pointerId)) return;
    if (this.activeTouchIdentifiers.has(touchIdentifier)) return;
    const state = this.pointers.get(pointerId);
    if (!state || state.terminal || state.nativeTerminalSeen) return;
    const seen = this.pointerSeenAt.get(pointerId);
    if (seen != null && seen > now) return;
    const reason = touchTerminal === "active-set-reconciled" ? "active-set-reconciled" : "paired-touch-ended";
    state.terminal = true;
    state.retireReason = reason;
    this.pointers.set(pointerId, state);
    this.activePointerIds.delete(pointerId);
    this.pointerReconciliations.push({
      event: "stale-pinch-pointer-reconciled",
      pointerId,
      pairedTouchIdentifier: touchIdentifier,
      nativePointerTerminalSeen: false,
      pairedTouchTerminal: touchTerminal,
      remainingActiveTouches: [...this.activeTouchIdentifiers],
      reason,
      pointerLastSeenAgeMs: seen == null ? null : Math.max(0, now - seen)
    });
  }

  private retirePairedTouch(pointerId: number): void {
    const touchIdentifier = this.pointerToTouch.get(pointerId);
    if (touchIdentifier == null || this.touchToPointer.get(touchIdentifier) !== pointerId) return;
    if (this.touches.get(touchIdentifier)?.terminal) return;
    this.finishTouch(touchIdentifier);
  }

  private finishTouch(id: number): void {
    const state = this.touches.get(id) ?? { terminal: true };
    state.terminal = true;
    this.touches.set(id, state);
    this.activeTouchIdentifiers.delete(id);
  }

  private pruneTouch(id: number, reason: StalePinchPrune["reason"], now: number): StalePinchPrune {
    const lastSeenAt = this.touchSeenAt.get(id) ?? null;
    this.finishTouch(id);
    return {
      event: "stale-pinch-contact-pruned",
      id,
      stream: "touch",
      lastSeenAt,
      ageMs: lastSeenAt == null ? null : Math.max(0, now - lastSeenAt),
      reason
    };
  }

  private pruneInactive(
    stream: "pointer" | "touch",
    records: Map<number, { terminal: boolean }>,
    active: ReadonlySet<number>,
    now: number
  ): StalePinchPrune[] {
    const pruned: StalePinchPrune[] = [];
    const seen = stream === "pointer" ? this.pointerSeenAt : this.touchSeenAt;
    for (const [id, state] of records) {
      if (state.terminal || active.has(id)) continue;
      const lastSeenAt = seen.get(id) ?? null;
      state.terminal = true;
      pruned.push({
        event: "stale-pinch-contact-pruned",
        id,
        stream,
        lastSeenAt,
        ageMs: lastSeenAt == null ? null : Math.max(0, now - lastSeenAt),
        reason: "stale-before-burst"
      });
    }
    return pruned;
  }

  noteAnimationFrame(): void {
    this.animationFrames += 1;
  }

  needsAnimationFrame(): boolean {
    if (this.pinchPointers.size === 0 && this.pinchTouches.size === 0) return false;
    return this.animationFrames < 1;
  }

  /**
   * Quiescent once every pinch pointer and touch has a terminal event.
   * `lostpointercapture` is recorded, but it does not keep settle open after
   * the pointer already ended: the last build showed no annotation capture.
   */
  watchState(now = Date.now()): {
    timedOut: boolean;
    lastPinchEventAgeMs: number | null;
    stalePointerIds: number[];
    staleTouchIds: number[];
  } {
    const age = this.lastPinchEventAt == null ? null : Math.max(0, now - this.lastPinchEventAt);
    const stale = this.timedOut || (age != null && age > ZOOM_BURST_STUCK_MS);
    const stalePointerIds = stale
      ? [...this.pinchPointers].filter((id) => !this.pointers.get(id)?.terminal)
      : [];
    const staleTouchIds = stale
      ? [...this.pinchTouches].filter((id) => !this.touches.get(id)?.terminal && !this.stylusAssociated.has(id))
      : [];
    return { timedOut: this.timedOut, lastPinchEventAgeMs: age, stalePointerIds, staleTouchIds };
  }

  activePinchCount(): { pointers: number; touches: number } {
    return {
      pointers: [...this.pinchPointers].filter((id) => !this.pointers.get(id)?.terminal).length,
      touches: [...this.pinchTouches].filter((id) => !this.touches.get(id)?.terminal && !this.stylusAssociated.has(id)).length
    };
  }

  diagnostics(): { evaluateCount: number; needsAnimationFrame: boolean } {
    return { evaluateCount: this.evaluateCount, needsAnimationFrame: this.needsAnimationFrame() };
  }

  evaluate(now: number, maxWaitMs = PINCH_CLEANUP_MAX_WAIT_MS): PinchCleanupReport {
    this.evaluateCount += 1;
    const activePinchPointersAtSettle = [...this.pinchPointers].filter((id) => !this.pointers.get(id)?.terminal);
    const activePinchTouchesAtSettle = [...this.pinchTouches].filter((id) => !this.touches.get(id)?.terminal);
    const blocking = activePinchPointersAtSettle.length > 0 || activePinchTouchesAtSettle.length > 0;
    if (blocking && !this.timedOut) {
      if (this.deferredAt === null) this.deferredAt = now;
      this.animationFrames = 0;
    }
    const gestureCleanupWaitMs = this.deferredAt === null ? 0 : Math.max(0, Math.round(now - this.deferredAt));
    if (blocking && gestureCleanupWaitMs >= maxWaitMs) this.timedOut = true;
    const reconciled = this.reconciliationState();
    return {
      pinchPointerIds: [...this.pinchPointers],
      pinchTouchIdentifiers: [...this.pinchTouches],
      terminalPointerIds: [...this.pinchPointers].filter((id) => this.pointers.get(id)?.terminal === true),
      terminalTouchIdentifiers: [...this.pinchTouches].filter((id) => this.touches.get(id)?.terminal === true),
      lostCapturePointerIds: [...this.pinchPointers].filter((id) => this.pointers.get(id)?.lostCapture === true),
      ...reconciled,
      activePinchPointersAtSettle,
      activePinchTouchesAtSettle,
      settleDeferredForGestureCleanup: this.deferredAt !== null,
      gestureCleanupWaitMs,
      postCleanupAnimationFrames: this.animationFrames,
      gestureCleanupTimedOut: this.timedOut,
      quiescent: !blocking || this.timedOut
    };
  }
}
