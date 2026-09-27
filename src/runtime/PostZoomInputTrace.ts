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
    this.remember("zoom-begin", { zoomBurstId: this.activeId }, at);
    return this.activeId;
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
  }

  settle(atMs: number, snapshot: Record<string, unknown> = {}): string | null {
    if (!this.activeId) return this.settledId;
    this.settledId = this.activeId;
    this.settledAt = atMs;
    this.contactsLogged = 0;
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
    this.remember("post-zoom-input-anomaly", {
      reason: payload.reason,
      classification,
      physicalContactId: contact.physicalContactId
    });
    return payload;
  }
}
