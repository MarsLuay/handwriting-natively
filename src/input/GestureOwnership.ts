export type InputOwner = "idle" | "pen-ink";

export interface ActiveInputState {
  owner: InputOwner;
  activePenId: number | null;
  generation: number;
}

export interface GestureContact {
  pointerId: number;
  pointerType: "pen" | "touch" | "mouse";
  target?: "page" | "ui";
  inkToolSelected?: boolean;
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

/** Owns stylus annotation contacts; mouse and touch stay with their native viewer. */
export class GestureOwnership {
  private owner: InputOwner = "idle";
  private activePenId: number | null = null;
  private readonly ignoredPenIds = new Set<number>();
  private generation = 1;

  snapshot(): ActiveInputState {
    return cloneState({
      owner: this.owner,
      activePenId: this.activePenId,
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
    if (contact.pointerType !== "pen") return this.observe("observe");
    if (contact.target !== "page" || !contact.inkToolSelected) return this.observe("observe");
    if (this.activePenId !== null && this.activePenId !== contact.pointerId) {
      this.ignoredPenIds.add(contact.pointerId);
      return this.decision("ignore", true);
    }
    this.owner = "pen-ink";
    this.activePenId = contact.pointerId;
    return this.claim();
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
    if (contact.pointerType !== "pen" || this.activePenId !== contact.pointerId) {
      return this.observe("observe");
    }
    const wasInk = this.owner === "pen-ink";
    this.activePenId = null;
    this.owner = "idle";
    return this.decision(inkAction, wasInk);
  }

  private clear(): void {
    this.owner = "idle";
    this.activePenId = null;
    this.ignoredPenIds.clear();
  }

  private append(contact: GestureContact): GestureDecision {
    return this.decision("append-ink", true, contact.samples, contact.predicted);
  }

  private claim(): GestureDecision {
    return this.decision("claim-ink", this.owner === "pen-ink");
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
