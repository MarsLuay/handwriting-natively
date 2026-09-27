import type { StylusIdentity } from "./PostZoomInputTrace";

/** Keep a short page-contact ring after Pencil has recovered from zoom. */
export const POST_ZOOM_DURABILITY_WINDOW_MS = 180_000;
export const POST_ZOOM_DURABILITY_CONTACT_LIMIT = 30;

export interface PostZoomDurabilityContact {
  at: string;
  physicalContactId: string;
  pointerType: string | null;
  pointerEventPenSeen: boolean;
  pointerEventTouchSeen: boolean;
  touchEventSeen: boolean;
  classification: string | null;
  pressure: number | null;
  width: number | null;
  height: number | null;
  stylusIdentity: StylusIdentity;
  physicalToolClaimed: boolean;
  physicalTool: "apple-pencil" | null;
  pageNumber: number | null;
  pageMountGeneration: number | null;
  pageElementId: number | null;
  overlayId: number | null;
  routerGeneration: number | null;
  routerReceived: boolean;
  routerRejected: boolean;
  routerRejectReason: string | null;
  route: string | null;
  strokeStarted: boolean;
  strokeEnded: boolean;
  scrollLeftAtStart: number | null;
  scrollTopAtStart: number | null;
  scrollLeftAtEnd: number | null;
  scrollTopAtEnd: number | null;
  nativeScrollDeltaPx: number | null;
  panObserved: boolean;
  panAccepted: boolean | null;
  target: string | null;
  composedPath: readonly string[] | null;
  touchActionClasses: readonly string[] | null;
  activeElement: string | null;
}

export interface PostZoomRecoveryRegressed {
  event: "post-zoom-recovery-regressed";
  zoomBurstId: string;
  previousSuccessfulPenAt: string;
  currentPointerType: string;
  currentStylusIdentity: StylusIdentity;
  physicalToolClaimed: false;
  physicalContactId: string;
}

export interface PostZoomPageDragContact {
  event: "post-zoom-page-drag-contact";
  zoomBurstId: string;
  physicalContactId: string;
  pointerType: string;
  routerReceived: false;
  strokeStarted: false;
  nativeScrollDeltaPx: number;
  panObserved: true;
  physicalToolClaimed: boolean;
  physicalTool: "apple-pencil" | null;
}

export interface LastPostZoomDurabilityTrace {
  zoomBurstId: string | null;
  zoomSettledAt: string | null;
  firstSuccessfulPostZoomPenAt: string | null;
  successfulPenContactsAfterZoom: number;
  lastSuccessfulPenContactAt: string | null;
  firstLaterGenericTouchAfterPenRecovery: PostZoomDurabilityContact | null;
  firstLaterRouterFailureAfterPenRecovery: PostZoomDurabilityContact | null;
  firstLaterPageDragAfterPenRecovery: PostZoomDurabilityContact | null;
  durabilityWindowAgeMs: number | null;
  durabilityWindowExpired: boolean;
  contacts: PostZoomDurabilityContact[];
}

export interface PostZoomDurabilityNote extends Omit<PostZoomDurabilityContact, "at" | "physicalToolClaimed" | "physicalTool"> {
  atMs: number;
}

export type PostZoomDurabilityEvent = PostZoomRecoveryRegressed | PostZoomPageDragContact;

function cloneContact(contact: PostZoomDurabilityContact): PostZoomDurabilityContact {
  return {
    ...contact,
    composedPath: contact.composedPath ? [...contact.composedPath] : null,
    touchActionClasses: contact.touchActionClasses ? [...contact.touchActionClasses] : null
  };
}

/** Browser pen evidence plus a started stroke. Width, radius, and pressure do not count. */
export function durabilitySuccessfulPen(contact: Pick<PostZoomDurabilityContact, "pointerEventPenSeen" | "strokeStarted" | "stylusIdentity">): boolean {
  return contact.pointerEventPenSeen && contact.strokeStarted && contact.stylusIdentity === "established";
}

export class PostZoomDurabilityTrace {
  private zoomBurstId: string | null = null;
  private settledAtMs: number | null = null;
  private firstSuccessfulPostZoomPenAt: string | null = null;
  private successfulPenContactsAfterZoom = 0;
  private lastSuccessfulPenContactAt: string | null = null;
  private firstLaterGenericTouchAfterPenRecovery: PostZoomDurabilityContact | null = null;
  private firstLaterRouterFailureAfterPenRecovery: PostZoomDurabilityContact | null = null;
  private firstLaterPageDragAfterPenRecovery: PostZoomDurabilityContact | null = null;
  private readonly contacts: PostZoomDurabilityContact[] = [];
  private readonly claimedTools = new Map<string, "apple-pencil">();

  onZoomBegin(zoomBurstId: string): void {
    this.zoomBurstId = zoomBurstId;
    this.settledAtMs = null;
    this.firstSuccessfulPostZoomPenAt = null;
    this.successfulPenContactsAfterZoom = 0;
    this.lastSuccessfulPenContactAt = null;
    this.firstLaterGenericTouchAfterPenRecovery = null;
    this.firstLaterRouterFailureAfterPenRecovery = null;
    this.firstLaterPageDragAfterPenRecovery = null;
    this.contacts.length = 0;
    this.claimedTools.clear();
  }

  onZoomSettle(zoomBurstId: string, atMs: number): void {
    this.zoomBurstId = zoomBurstId;
    this.settledAtMs = atMs;
  }

  /** User confirmed the physical tool. Browser pointer fields stay unchanged. */
  claimPhysicalTool(physicalContactId: string, tool: "apple-pencil"): void {
    this.claimedTools.set(physicalContactId, tool);
    for (const contact of this.contacts) this.applyClaim(contact);
    if (this.firstLaterGenericTouchAfterPenRecovery) this.applyClaim(this.firstLaterGenericTouchAfterPenRecovery);
    if (this.firstLaterRouterFailureAfterPenRecovery) this.applyClaim(this.firstLaterRouterFailureAfterPenRecovery);
    if (this.firstLaterPageDragAfterPenRecovery) this.applyClaim(this.firstLaterPageDragAfterPenRecovery);
  }

  note(input: PostZoomDurabilityNote): PostZoomDurabilityEvent[] {
    if (this.zoomBurstId === null || this.settledAtMs === null) return [];
    if (input.atMs - this.settledAtMs > POST_ZOOM_DURABILITY_WINDOW_MS) return [];
    const contact = this.toContact(input);
    const successfulPen = durabilitySuccessfulPen(contact);
    this.push(contact);
    if (successfulPen) {
      this.rememberPen(contact);
      return [];
    }
    if (!this.firstSuccessfulPostZoomPenAt) return [];
    const events: PostZoomDurabilityEvent[] = [];
    const identityLost = !contact.pointerEventPenSeen
      && contact.stylusIdentity === "absent"
      && contact.pointerType !== "pen";
    if (identityLost && !this.firstLaterGenericTouchAfterPenRecovery) {
      this.firstLaterGenericTouchAfterPenRecovery = cloneContact(contact);
      events.push({
        event: "post-zoom-recovery-regressed",
        zoomBurstId: this.zoomBurstId,
        previousSuccessfulPenAt: this.firstSuccessfulPostZoomPenAt,
        currentPointerType: contact.pointerType ?? "touch",
        currentStylusIdentity: contact.stylusIdentity,
        physicalToolClaimed: false,
        physicalContactId: contact.physicalContactId
      });
    }
    const routerFailed = contact.stylusIdentity === "established"
      && !contact.strokeStarted
      && (!contact.routerReceived || contact.routerRejected);
    if (routerFailed && !this.firstLaterRouterFailureAfterPenRecovery) {
      this.firstLaterRouterFailureAfterPenRecovery = cloneContact(contact);
    }
    const pageDrag = !contact.strokeStarted
      && !contact.routerReceived
      && contact.panObserved
      && contact.nativeScrollDeltaPx !== null
      && contact.nativeScrollDeltaPx > 0;
    if (pageDrag && !this.firstLaterPageDragAfterPenRecovery) {
      this.firstLaterPageDragAfterPenRecovery = cloneContact(contact);
      events.push({
        event: "post-zoom-page-drag-contact",
        zoomBurstId: this.zoomBurstId,
        physicalContactId: contact.physicalContactId,
        pointerType: contact.pointerType ?? "touch",
        routerReceived: false,
        strokeStarted: false,
        nativeScrollDeltaPx: contact.nativeScrollDeltaPx!,
        panObserved: true,
        physicalToolClaimed: contact.physicalToolClaimed,
        physicalTool: contact.physicalTool
      });
    }
    return events;
  }

  snapshot(atMs: number): LastPostZoomDurabilityTrace {
    const age = this.settledAtMs === null ? null : Math.max(0, atMs - this.settledAtMs);
    return {
      zoomBurstId: this.zoomBurstId,
      zoomSettledAt: this.settledAtMs === null ? null : new Date(this.settledAtMs).toISOString(),
      firstSuccessfulPostZoomPenAt: this.firstSuccessfulPostZoomPenAt,
      successfulPenContactsAfterZoom: this.successfulPenContactsAfterZoom,
      lastSuccessfulPenContactAt: this.lastSuccessfulPenContactAt,
      firstLaterGenericTouchAfterPenRecovery: this.firstLaterGenericTouchAfterPenRecovery
        ? cloneContact(this.firstLaterGenericTouchAfterPenRecovery)
        : null,
      firstLaterRouterFailureAfterPenRecovery: this.firstLaterRouterFailureAfterPenRecovery
        ? cloneContact(this.firstLaterRouterFailureAfterPenRecovery)
        : null,
      firstLaterPageDragAfterPenRecovery: this.firstLaterPageDragAfterPenRecovery
        ? cloneContact(this.firstLaterPageDragAfterPenRecovery)
        : null,
      durabilityWindowAgeMs: age,
      durabilityWindowExpired: age !== null && age > POST_ZOOM_DURABILITY_WINDOW_MS,
      contacts: this.contacts.map(cloneContact)
    };
  }

  private rememberPen(contact: PostZoomDurabilityContact): void {
    if (!this.firstSuccessfulPostZoomPenAt) this.firstSuccessfulPostZoomPenAt = contact.at;
    this.successfulPenContactsAfterZoom += 1;
    this.lastSuccessfulPenContactAt = contact.at;
  }

  private push(contact: PostZoomDurabilityContact): void {
    this.contacts.push(contact);
    if (this.contacts.length > POST_ZOOM_DURABILITY_CONTACT_LIMIT) {
      this.contacts.splice(0, this.contacts.length - POST_ZOOM_DURABILITY_CONTACT_LIMIT);
    }
  }

  private applyClaim(contact: PostZoomDurabilityContact): void {
    const tool = this.claimedTools.get(contact.physicalContactId);
    if (!tool) return;
    contact.physicalToolClaimed = true;
    contact.physicalTool = tool;
  }

  private toContact(input: PostZoomDurabilityNote): PostZoomDurabilityContact {
    const tool = this.claimedTools.get(input.physicalContactId) ?? null;
    return {
      at: new Date(input.atMs).toISOString(),
      physicalContactId: input.physicalContactId,
      pointerType: input.pointerType,
      pointerEventPenSeen: input.pointerEventPenSeen,
      pointerEventTouchSeen: input.pointerEventTouchSeen,
      touchEventSeen: input.touchEventSeen,
      classification: input.classification,
      pressure: input.pressure,
      width: input.width,
      height: input.height,
      stylusIdentity: input.stylusIdentity,
      physicalToolClaimed: tool !== null,
      physicalTool: tool,
      pageNumber: input.pageNumber,
      pageMountGeneration: input.pageMountGeneration,
      pageElementId: input.pageElementId,
      overlayId: input.overlayId,
      routerGeneration: input.routerGeneration,
      routerReceived: input.routerReceived,
      routerRejected: input.routerRejected,
      routerRejectReason: input.routerRejectReason,
      route: input.route,
      strokeStarted: input.strokeStarted,
      strokeEnded: input.strokeEnded,
      scrollLeftAtStart: input.scrollLeftAtStart,
      scrollTopAtStart: input.scrollTopAtStart,
      scrollLeftAtEnd: input.scrollLeftAtEnd,
      scrollTopAtEnd: input.scrollTopAtEnd,
      nativeScrollDeltaPx: input.nativeScrollDeltaPx,
      panObserved: input.panObserved,
      panAccepted: input.panAccepted,
      target: input.target,
      composedPath: input.composedPath ? [...input.composedPath] : null,
      touchActionClasses: input.touchActionClasses ? [...input.touchActionClasses] : null,
      activeElement: input.activeElement
    };
  }
}
