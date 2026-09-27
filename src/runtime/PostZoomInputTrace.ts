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
    anomalyLifecycle: []
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
    this.remember("zoom-begin", { zoomBurstId: this.activeId }, at);
    return this.activeId;
  }

  /** Compact diagnosis kept after the ordinary log ring scrolls away. */
  diagnosis(): LastZoomDiagnosis {
    return {
      ...this.diagnosisState,
      settleSnapshot: this.diagnosisState.settleSnapshot ? { ...this.diagnosisState.settleSnapshot } : null,
      firstPostZoomContacts: this.diagnosisState.firstPostZoomContacts.map((contact) => ({ ...contact })),
      lastPostZoomAnomaly: this.diagnosisState.lastPostZoomAnomaly ? { ...this.diagnosisState.lastPostZoomAnomaly } : null,
      anomalyLifecycle: this.diagnosisState.anomalyLifecycle.map((event) => ({ ...event, details: { ...event.details } }))
    };
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
    if (event === "post-zoom-contact" && this.diagnosisState.firstPostZoomContacts.length < POST_ZOOM_CONTACT_LIMIT) {
      this.diagnosisState.firstPostZoomContacts.push({ ...details });
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
