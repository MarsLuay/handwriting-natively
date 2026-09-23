/**
 * Small, DOM-free state machine for mobile PDF manipulation ownership.
 *
 * When the host can own native pinch, the viewer page starts in a
 * `pan-x pan-y pinch-zoom`-compatible state so the browser sees that policy
 * before the first finger arrives. A pen signal switches the router to its
 * per-page `touch-action: none` guard before the pen is routed. Hosts without
 * a native pinch path retain the stricter guard and use the explicit touch state.
 */

export type ManipulationState =
  | "armed"
  | "assisted-touch"
  | "native-touch"
  | "pinch"
  | "touch-linger";

export interface ManipulationPlatformCapabilities {
  /** Whether touch-action can be committed before a contact arrives. */
  supportsTouchAction: boolean;
  /** Whether the host/viewer can own a native two-finger pinch. */
  supportsNativePinch: boolean;
}

export const DEFAULT_MANIPULATION_PLATFORM_CAPABILITIES: ManipulationPlatformCapabilities = {
  supportsTouchAction: true,
  supportsNativePinch: true
};

/** One-shot delay before the standing cold-contact guard is restored. */
export const MANIPULATION_REARM_MS = 1_000;

export type ManipulationTransitionName =
  | "pen-signal"
  | "touch-start"
  | "pinch-start"
  | "touch-end"
  | "rearm"
  | "reset";

export interface ManipulationTransition {
  event: ManipulationTransitionName;
  from: ManipulationState;
  to: ManipulationState;
  touchAction: "none" | "pan-xy";
  assistThisGesture: boolean;
  pinchTakeover: boolean;
  cancelAssist: boolean;
  scheduleRearm: boolean;
  cancelRearm: boolean;
  activeTouches: number;
  panned?: boolean;
}

export class ManipulationStateMachine {
  private currentState: ManipulationState = "armed";
  private activeTouchCount = 0;
  private last: ManipulationTransition | null = null;

  constructor(
    private readonly capabilities: ManipulationPlatformCapabilities = DEFAULT_MANIPULATION_PLATFORM_CAPABILITIES
  ) {}

  get state(): ManipulationState {
    return this.currentState;
  }

  get activeTouches(): number {
    return this.activeTouchCount;
  }

  get lastTransition(): ManipulationTransition | null {
    return this.last;
  }

  touchAction(): "none" | "pan-xy" {
    if (!this.capabilities.supportsTouchAction) return "pan-xy";
    if (this.currentState === "armed" || this.currentState === "assisted-touch") {
      return this.capabilities.supportsNativePinch ? "pan-xy" : "none";
    }
    if (this.currentState === "pinch" && !this.capabilities.supportsNativePinch) return "none";
    return "pan-xy";
  }

  penSignal(): ManipulationTransition {
    const from = this.currentState;
    const cancelRearm = from === "touch-linger";
    this.currentState = "armed";
    return this.record({
      event: "pen-signal",
      from,
      assistThisGesture: false,
      pinchTakeover: false,
      cancelAssist: from === "assisted-touch",
      scheduleRearm: false,
      cancelRearm,
      activeTouches: this.activeTouchCount
    }, from === "assisted-touch" ? "none" : undefined);
  }

  touchStart(): ManipulationTransition {
    const from = this.currentState;
    this.activeTouchCount += 1;
    if (this.activeTouchCount >= 2) {
      return this.pinchStart(from);
    }
    if (!this.capabilities.supportsTouchAction || from === "touch-linger" || from === "native-touch") {
      this.currentState = "native-touch";
      return this.record({
        event: "touch-start",
        from,
        assistThisGesture: false,
        pinchTakeover: false,
        cancelAssist: false,
        scheduleRearm: false,
        cancelRearm: from === "touch-linger",
        activeTouches: this.activeTouchCount
      });
    }
    this.currentState = "assisted-touch";
    return this.record({
      event: "touch-start",
      from,
      assistThisGesture: true,
      pinchTakeover: false,
      cancelAssist: false,
      scheduleRearm: false,
      cancelRearm: false,
      activeTouches: this.activeTouchCount
    });
  }

  pinchStart(previousState: ManipulationState = this.currentState): ManipulationTransition {
    const from = previousState;
    this.activeTouchCount = Math.max(2, this.activeTouchCount);
    this.currentState = "pinch";
    return this.record({
      event: "pinch-start",
      from,
      assistThisGesture: false,
      pinchTakeover: true,
      cancelAssist: from === "assisted-touch",
      scheduleRearm: false,
      cancelRearm: from === "touch-linger" || from === "native-touch",
      activeTouches: this.activeTouchCount
    });
  }

  touchEnd(panned: boolean): ManipulationTransition {
    const from = this.currentState;
    this.activeTouchCount = Math.max(0, this.activeTouchCount - 1);
    let scheduleRearm = false;
    if (this.activeTouchCount === 0) {
      if ((from === "assisted-touch" || from === "native-touch") && panned) {
        this.currentState = "touch-linger";
        scheduleRearm = true;
      } else {
        this.currentState = "armed";
      }
    }
    return this.record({
      event: "touch-end",
      from,
      assistThisGesture: false,
      pinchTakeover: false,
      cancelAssist: false,
      scheduleRearm,
      cancelRearm: false,
      activeTouches: this.activeTouchCount,
      panned
    });
  }

  rearm(): ManipulationTransition {
    const from = this.currentState;
    if (from === "touch-linger") this.currentState = "armed";
    return this.record({
      event: "rearm",
      from,
      assistThisGesture: false,
      pinchTakeover: false,
      cancelAssist: false,
      scheduleRearm: false,
      cancelRearm: false,
      activeTouches: this.activeTouchCount
    });
  }

  reset(): ManipulationTransition {
    const from = this.currentState;
    this.currentState = "armed";
    this.activeTouchCount = 0;
    return this.record({
      event: "reset",
      from,
      assistThisGesture: false,
      pinchTakeover: false,
      cancelAssist: false,
      scheduleRearm: false,
      cancelRearm: false,
      activeTouches: 0
    });
  }

  private record(
    transition: Omit<ManipulationTransition, "to" | "touchAction">,
    touchActionOverride?: "none" | "pan-xy"
  ): ManipulationTransition {
    const result: ManipulationTransition = {
      ...transition,
      to: this.currentState,
      touchAction: touchActionOverride ?? this.touchAction()
    };
    this.last = result;
    return result;
  }
}
