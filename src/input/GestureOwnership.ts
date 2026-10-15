export type InputOwner = "idle" | "pen-ink" | "mouse-ink";

export interface ActiveInputState {
  owner: InputOwner;
  activePenId: number | null;
  activeMousePointerId: number | null;
  activeMouseButtons: number;
  generation: number;
}

export interface GestureContact {
  pointerId: number;
  pointerType: "pen" | "touch" | "mouse";
  button?: number;
  buttons?: number;
  target?: "page" | "ui";
  inkToolSelected?: boolean;
  inkIntent?: boolean;
  samples?: readonly string[];
  predicted?: readonly string[];
}

export interface GestureDecision {
  state: ActiveInputState;
  action: "claim-ink" | "append-ink" | "finalize-ink" | "observe" | "ignore" | "preview";
  preventDefault: boolean;
  persistSamples: readonly string[];
  previewSamples: readonly string[];
}

function cloneState(state: ActiveInputState): ActiveInputState {
  return { ...state };
}

function mouseButtonMask(contact: Pick<GestureContact, "button" | "buttons">): number {
  if (contact.buttons !== undefined && contact.buttons !== 0) return contact.buttons;
  const button = contact.button ?? 0;
  return button >= 0 && button < 5 ? 1 << button : 0;
}

/** Owns stylus and opted-in mouse annotation contacts; touch navigation has a separate owner. */
export class GestureOwnership {
  private owner: InputOwner = "idle";
  private activePenId: number | null = null;
  private activeMousePointerId: number | null = null;
  private activeMouseButtons = 0;
  private readonly ignoredPenIds = new Set<number>();
  private generation = 1;

  snapshot(): ActiveInputState {
    return cloneState({
      owner: this.owner,
      activePenId: this.activePenId,
      activeMousePointerId: this.activeMousePointerId,
      activeMouseButtons: this.activeMouseButtons,
      generation: this.generation
    });
  }

  replaceGeneration(): ActiveInputState {
    this.clear();
    this.generation += 1;
    return this.snapshot();
  }

  adoptPenContact(pointerId: number): ActiveInputState {
    this.owner = "pen-ink";
    this.activePenId = pointerId;
    return this.snapshot();
  }

  ignoredPenContactIds(): number[] {
    return [...this.ignoredPenIds];
  }

  adoptIgnoredPenContacts(pointerIds: readonly number[]): void {
    for (const pointerId of pointerIds) {
      if (pointerId !== this.activePenId) this.ignoredPenIds.add(pointerId);
    }
  }

  pointerDown(contact: GestureContact): GestureDecision {
    if (contact.pointerType === "pen" && this.ignoredPenIds.has(contact.pointerId)) {
      return this.decision("ignore", true);
    }
    if (contact.target === "ui") return this.observe("ignore");
    if (contact.pointerType === "touch") return this.observe("observe");
    if (contact.pointerType === "pen") {
      if (contact.target !== "page" || !contact.inkToolSelected) return this.observe("observe");
      if (this.activePenId !== null && this.activePenId !== contact.pointerId) {
        this.ignoredPenIds.add(contact.pointerId);
        return this.decision("ignore", true);
      }
      this.owner = "pen-ink";
      this.activePenId = contact.pointerId;
      return this.claim();
    }
    if (contact.target !== "page" || !contact.inkToolSelected || contact.inkIntent !== true) {
      return this.observe("observe");
    }
    this.activeMousePointerId = contact.pointerId;
    this.activeMouseButtons = mouseButtonMask(contact);
    if (this.activePenId === null) this.owner = "mouse-ink";
    return this.owner === "mouse-ink" ? this.claim() : this.observe("observe");
  }

  pointerMove(contact: GestureContact): GestureDecision {
    if (contact.pointerType === "pen" && this.ignoredPenIds.has(contact.pointerId)) {
      return this.decision("ignore", true);
    }
    if (contact.pointerType === "pen"
      && this.owner === "pen-ink"
      && this.activePenId === contact.pointerId) {
      return this.append(contact);
    }
    if (contact.pointerType === "mouse"
      && this.owner === "mouse-ink"
      && this.activeMousePointerId === contact.pointerId) {
      this.activeMouseButtons = contact.buttons ?? this.activeMouseButtons;
      return this.append(contact);
    }
    return this.observe("observe");
  }

  pointerUp(contact: GestureContact): GestureDecision {
    return this.release(contact, "finalize-ink");
  }

  pointerCancel(contact: GestureContact): GestureDecision {
    return this.release(contact, "ignore");
  }

  lostCapture(contact: GestureContact): GestureDecision {
    if (contact.pointerType === "pen" && this.ignoredPenIds.has(contact.pointerId)) {
      return this.decision("ignore", true);
    }
    return this.release(contact, "ignore");
  }

  private release(contact: GestureContact, inkAction: "finalize-ink" | "ignore"): GestureDecision {
    if (contact.pointerType === "pen" && this.ignoredPenIds.delete(contact.pointerId)) {
      return this.decision("ignore", true);
    }
    if (contact.pointerType === "pen") {
      if (this.activePenId !== contact.pointerId) return this.observe("observe");
      const wasInk = this.owner === "pen-ink";
      this.activePenId = null;
      this.restoreOwnerAfterRelease();
      return this.decision(inkAction, wasInk);
    }
    if (contact.pointerType === "touch") return this.observe("observe");
    if (this.activeMousePointerId !== contact.pointerId) {
      return this.observe("observe");
    }
    this.activeMouseButtons &= ~mouseButtonMask(contact);
    if (contact.buttons === undefined || contact.buttons === 0) this.activeMouseButtons = 0;
    if (this.activeMouseButtons === 0) {
      const wasInk = this.owner === "mouse-ink";
      this.activeMousePointerId = null;
      this.restoreOwnerAfterRelease();
      return this.decision(inkAction, wasInk);
    }
    return this.observe("observe");
  }

  private restoreOwnerAfterRelease(): void {
    if (this.activePenId !== null) {
      this.owner = "pen-ink";
      return;
    }
    if (this.activeMousePointerId !== null && this.activeMouseButtons !== 0) {
      this.owner = "mouse-ink";
      return;
    }
    this.owner = "idle";
  }

  private clear(): void {
    this.owner = "idle";
    this.activePenId = null;
    this.activeMousePointerId = null;
    this.activeMouseButtons = 0;
    this.ignoredPenIds.clear();
  }

  private append(contact: GestureContact): GestureDecision {
    return this.decision("append-ink", true, contact.samples, contact.predicted);
  }

  private claim(): GestureDecision {
    return this.decision("claim-ink", this.owner === "pen-ink" || this.owner === "mouse-ink");
  }

  private decision(
    action: GestureDecision["action"],
    preventDefault: boolean,
    persistSamples: readonly string[] = [],
    previewSamples: readonly string[] = []
  ): GestureDecision {
    return {
      state: this.snapshot(),
      action,
      preventDefault,
      persistSamples: [...persistSamples],
      previewSamples: [...previewSamples]
    };
  }

  private observe(action: "observe" | "ignore"): GestureDecision {
    return this.decision(action, false);
  }
}
