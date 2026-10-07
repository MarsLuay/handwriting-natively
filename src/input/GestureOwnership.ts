export type InputOwner =
  | "idle"
  | "pen-ink"
  | "mouse-ink";

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

export interface GestureOwnershipOptions {
  customPinchEnabled?: boolean;
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

/**
 * Owns annotation pointer contacts. GestureNavigationController owns touch
 * navigation and stylus exclusion for navigation gestures.
 *
 * Routers and sessions may retain stroke/rendering state, but they must not
 * independently decide whether a pen or mouse owns an annotation gesture.
 */
export class GestureOwnership {
  private owner: InputOwner = "idle";
  private activePenId: number | null = null;
  private activeMousePointerId: number | null = null;
  private activeMouseButtons = 0;
  private generation = 1;

  constructor(options: GestureOwnershipOptions = {}) {}

  observeTouchEvent(): GestureDecision {
    return this.observe("observe");
  }

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

  pointerDown(contact: GestureContact): GestureDecision {
    if (contact.target === "ui") return this.observe("ignore");

    if (contact.pointerType === "touch") return this.observe("observe");

    if (contact.pointerType === "pen") {
      if (contact.target !== "page" || !contact.inkToolSelected) return this.observe("observe");
      this.owner = "pen-ink";
      this.activePenId = contact.pointerId;
      return this.claim("claim-ink");
    }

    if (contact.target !== "page" || !contact.inkToolSelected || contact.inkIntent !== true) {
      return this.observe("observe");
    }
    this.owner = "mouse-ink";
    this.activeMousePointerId = contact.pointerId;
    this.activeMouseButtons = mouseButtonMask(contact);
    return this.claim("claim-ink");
  }

  pointerMove(contact: GestureContact): GestureDecision {
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
    return this.release(contact, "ignore");
  }

  private release(contact: GestureContact, inkAction: "finalize-ink" | "ignore"): GestureDecision {
    if (contact.pointerType === "pen") {
      if (this.activePenId !== contact.pointerId) return this.observe("observe");
      const wasInk = this.owner === "pen-ink";
      this.activePenId = null;
      this.owner = "idle";
      return this.decision(inkAction, wasInk);
    }

    if (contact.pointerType === "touch") return this.observe("observe");

    if (this.activeMousePointerId !== contact.pointerId) return this.observe("observe");
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
    if (this.activeMousePointerId !== null && this.activeMouseButtons !== 0) return;
    this.owner = "idle";
  }

  private clear(): void {
    this.owner = "idle";
    this.activePenId = null;
    this.activeMousePointerId = null;
    this.activeMouseButtons = 0;
  }

  private append(contact: GestureContact): GestureDecision {
    return this.decision("append-ink", true, contact.samples, contact.predicted);
  }

  private claim(action: GestureDecision["action"]): GestureDecision {
    return this.decision(
      action,
      this.owner === "pen-ink" || this.owner === "mouse-ink"
    );
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
