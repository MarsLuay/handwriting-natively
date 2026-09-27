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
    return this.activeId ?? this.settledId;
  }

  begin(at = new Date().toISOString()): string {
    this.serial += 1;
    this.activeId = `zoom-${this.serial}`;
    this.settledId = null;
    this.settledAt = 0;
    this.contactsLogged = 0;
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
  notePageContact(atMs: number, overAnnotatablePage: boolean): { zoomBurstId: string; postZoomContactIndex: number } | null {
    if (!this.settledId || !overAnnotatablePage) return null;
    if (atMs - this.settledAt > POST_ZOOM_WINDOW_MS) return null;
    if (this.contactsLogged >= POST_ZOOM_CONTACT_LIMIT) return null;
    this.contactsLogged += 1;
    return { zoomBurstId: this.settledId, postZoomContactIndex: this.contactsLogged };
  }

  anomaly(contact: PostZoomContactObservation): PostZoomAnomaly | null {
    const zoomBurstId = this.settledId;
    if (!zoomBurstId || this.anomalyContacts.has(contact.physicalContactId)) return null;
    const classification = classifyPostZoomFailure(contact);
    if (!classification) return null;
    this.anomalyContacts.add(contact.physicalContactId);
    const postZoomContactIndex = Math.max(1, this.contactsLogged);
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
    return payload;
  }
}

interface PinchPointerState {
  terminal: boolean;
  lostCapture: boolean;
}

export interface PinchCleanupReport {
  pinchPointerIds: number[];
  pinchTouchIdentifiers: number[];
  terminalPointerIds: number[];
  terminalTouchIdentifiers: number[];
  lostCapturePointerIds: number[];
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
  private readonly pointerSeenAt = new Map<number, number>();
  private readonly touchSeenAt = new Map<number, number>();
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
    for (const id of this.activeTouchIdentifiers) this.pinchTouches.add(id);
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

  endBurst(): void {
    this.tracking = false;
  }

  /** Drop touches the browser no longer lists, and clear everything when no touches remain. */
  reconcileTouches(eventType: string, changedIds: readonly number[], activeIds: readonly number[], now = Date.now()): StalePinchPrune[] {
    for (const id of changedIds) this.touchSeenAt.set(id, now);
    if (eventType === "touchend" || eventType === "touchcancel") {
      for (const id of changedIds) this.finishTouch(id);
    }
    if (activeIds.length === 0) return this.clearActiveTouches("touch-list-all-clear", now);
    const live = new Set(activeIds);
    for (const id of activeIds) {
      this.activeTouchIdentifiers.add(id);
      this.touches.set(id, { terminal: false });
      this.touchSeenAt.set(id, now);
      if (this.tracking) this.pinchTouches.add(id);
    }
    const pruned: StalePinchPrune[] = [];
    for (const id of [...this.activeTouchIdentifiers]) {
      if (live.has(id)) continue;
      pruned.push(this.pruneTouch(id, "not-in-current-active-set", now));
    }
    return pruned;
  }

  clearActiveTouches(reason: StalePinchPrune["reason"] = "touch-list-all-clear", now = Date.now()): StalePinchPrune[] {
    const pruned = [...this.activeTouchIdentifiers].map((id) => this.pruneTouch(id, reason, now));
    this.activeTouchIdentifiers.clear();
    if (!this.tracking) this.pinchTouches.clear();
    return pruned;
  }

  observePointer(pointerId: number, eventType: string, pointerType: string): void {
    if (pointerType === "pen" || pointerType === "mouse") return;
    const current = this.pointers.get(pointerId) ?? { terminal: false, lostCapture: false };
    this.pointerSeenAt.set(pointerId, Date.now());
    if (eventType === "pointerdown") {
      this.activePointerIds.add(pointerId);
      this.pointers.set(pointerId, { terminal: false, lostCapture: false });
    } else {
      if (eventType === "pointerup" || eventType === "pointercancel") {
        current.terminal = true;
        this.activePointerIds.delete(pointerId);
      }
      if (eventType === "lostpointercapture") current.lostCapture = true;
      this.pointers.set(pointerId, current);
    }
    if (this.tracking && this.activePointerIds.has(pointerId)) this.pinchPointers.add(pointerId);
    if (this.tracking || this.pinchPointers.has(pointerId)) this.lastPinchEventAt = Date.now();
  }

  observeTouch(identifier: number, eventType: string): void {
    this.touchSeenAt.set(identifier, Date.now());
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
    if (this.tracking && this.activeTouchIdentifiers.has(identifier)) this.pinchTouches.add(identifier);
    if (this.tracking || this.pinchTouches.has(identifier)) this.lastPinchEventAt = Date.now();
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
      ? [...this.pinchTouches].filter((id) => !this.touches.get(id)?.terminal)
      : [];
    return { timedOut: this.timedOut, lastPinchEventAgeMs: age, stalePointerIds, staleTouchIds };
  }

  activePinchCount(): { pointers: number; touches: number } {
    return {
      pointers: [...this.pinchPointers].filter((id) => !this.pointers.get(id)?.terminal).length,
      touches: [...this.pinchTouches].filter((id) => !this.touches.get(id)?.terminal).length
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
    return {
      pinchPointerIds: [...this.pinchPointers],
      pinchTouchIdentifiers: [...this.pinchTouches],
      terminalPointerIds: [...this.pinchPointers].filter((id) => this.pointers.get(id)?.terminal === true),
      terminalTouchIdentifiers: [...this.pinchTouches].filter((id) => this.touches.get(id)?.terminal === true),
      lostCapturePointerIds: [...this.pinchPointers].filter((id) => this.pointers.get(id)?.lostCapture === true),
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
