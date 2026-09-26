export type InputOwner =
  | "idle"
  | "pen-ink"
  | "native-touch-navigation"
  | "mouse-ink"
  | "mouse-pan";

export interface ActiveInputState {
  owner: InputOwner;
  activePenId: number | null;
  activeTouchIds: ReadonlySet<number>;
  activeMouseButtons: number;
  generation: number;
}

export interface GestureContact {
  pointerId: number;
  pointerType: "pen" | "touch" | "mouse";
  buttons?: number;
  target?: "page" | "ui";
  inkToolSelected?: boolean;
  mouseIntent?: "ink" | "pan";
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
  return {
    ...state,
    activeTouchIds: new Set(state.activeTouchIds)
  };
}

export class GestureOwnership {
  private owner: InputOwner = "idle";
  private activePenId: number | null = null;
  private readonly activeTouchIds = new Set<number>();
  private activeMouseButtons = 0;
  private generation = 1;

  snapshot(): ActiveInputState {
    return cloneState({
      owner: this.owner,
      activePenId: this.activePenId,
      activeTouchIds: this.activeTouchIds,
      activeMouseButtons: this.activeMouseButtons,
      generation: this.generation
    });
  }

  replaceGeneration(): ActiveInputState {
    this.clear();
    this.generation += 1;
    return this.snapshot();
  }

  pointerDown(contact: GestureContact): GestureDecision {
    if (contact.target === "ui" && this.owner === "idle") return this.observe("ignore");
    if (contact.pointerType === "pen") {
      if (this.owner === "pen-ink" && this.activePenId === contact.pointerId) return this.observe("ignore");
      if (!contact.inkToolSelected || contact.target === "ui") return this.observe("observe");
      this.owner = "pen-ink";
      this.activePenId = contact.pointerId;
      return this.claim("claim-ink", [String(contact.pointerId)]);
    }
    if (contact.pointerType === "touch") {
      this.activeTouchIds.add(contact.pointerId);
      if (this.owner === "pen-ink") return this.observe("observe");
      this.owner = "native-touch-navigation";
      return this.observe("observe");
    }
    this.activeMouseButtons = contact.buttons ?? 1;
    this.owner = contact.mouseIntent === "pan" ? "mouse-pan" : "mouse-ink";
    return this.claim(this.owner === "mouse-ink" ? "claim-ink" : "observe", []);
  }

  pointerMove(contact: GestureContact): GestureDecision {
    if (contact.pointerType === "pen" && this.owner === "pen-ink" && this.activePenId === contact.pointerId) {
      return {
        state: this.snapshot(),
        action: "append-ink",
        preventDefault: true,
        persistSamples: contact.samples ? [...contact.samples] : [],
        previewSamples: contact.predicted ? [...contact.predicted] : []
      };
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

  observeTouchEvent(): GestureDecision {
    return this.observe("observe");
  }

  private release(contact: GestureContact, penAction: "finalize-ink" | "ignore"): GestureDecision {
    if (contact.pointerType === "pen" && this.activePenId === contact.pointerId) {
      this.activePenId = null;
      if (this.owner === "pen-ink") this.owner = "idle";
      return this.claim(penAction, []);
    }
    if (contact.pointerType === "touch") {
      this.activeTouchIds.delete(contact.pointerId);
      if (this.owner === "native-touch-navigation" && this.activeTouchIds.size === 0) this.owner = "idle";
    }
    if (contact.pointerType === "mouse") {
      this.activeMouseButtons = 0;
      if (this.owner === "mouse-ink" || this.owner === "mouse-pan") this.owner = "idle";
    }
    return this.observe("observe");
  }

  private clear(): void {
    this.owner = "idle";
    this.activePenId = null;
    this.activeTouchIds.clear();
    this.activeMouseButtons = 0;
  }

  private claim(action: GestureDecision["action"], persistSamples: readonly string[]): GestureDecision {
    return {
      state: this.snapshot(),
      action,
      preventDefault: this.owner === "pen-ink" || this.owner === "mouse-ink",
      persistSamples,
      previewSamples: []
    };
  }

  private observe(action: GestureDecision["action"]): GestureDecision {
    return {
      state: this.snapshot(),
      action,
      preventDefault: false,
      persistSamples: [],
      previewSamples: []
    };
  }
}
