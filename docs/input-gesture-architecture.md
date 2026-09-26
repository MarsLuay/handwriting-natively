# Input gesture ownership architecture (#130)

This document is the implementation boundary for pen, finger, palm, mouse, and
native PDF gestures. It records the deterministic policy that can be tested in
this repository and the evidence that still requires Obsidian on physical
iPadOS hardware. It does not claim that synthetic DOM tests reproduce WebKit,
Scribble, Apple Pencil hover, or native PDF pinch behavior.

## Authority and ownership

Pointer Events are the authoritative input stream whenever the runtime exposes a
usable Pointer Events surface. Each physical contact is classified once and
enters one ownership state machine:

```ts
type InputOwner =
  | "idle"
  | "pen-ink"
  | "native-touch-navigation"
  | "mouse-ink"
  | "mouse-pan";

interface ActiveInputState {
  owner: InputOwner;
  activePenId: number | null;
  activeTouchIds: Set<number>;
  activeMouseButtons: number;
  generation: number;
}
```

The state machine owns contact identity and transitions. The stroke session
owns stroke lifecycle and page-coordinate conversion; it must consume routed
semantic actions rather than reclassifying a pointer as pen, finger, or palm.
A router generation invalidates callbacks from a replaced or destroyed viewer.

### Transition policy

| Current owner | Incoming contact | Result |
| --- | --- | --- |
| `idle` | pen down, ink-capable tool, annotatable page | claim `pen-ink` |
| `idle` | finger down | pass through as `native-touch-navigation` |
| `idle` | mouse draw gesture | claim `mouse-ink` |
| `idle` | configured mouse pan gesture | claim `mouse-pan` |
| `pen-ink` | matching pen move/up | append/finalize ink, then release |
| `pen-ink` | matching pen cancel/lost capture | cancel safely, then release |
| `pen-ink` | finger/palm contact | observe/track only; never transfer ink ownership |
| `native-touch-navigation` | second finger | remain native; preserve pinch/pan |
| any | UI target before a gesture is claimed | leave the UI event alone |
| any | blur, background, destroy, or generation replacement | clear every contact and capture |

A recognized active pen may annotate with the selected ink tool without a
separate Draw checkbox. Finger input remains navigation. Mouse intent remains
explicit because `pointerType="mouse"` does not identify the user's intent.

Width, height, radius, or pressure may be recorded as diagnostics, but they are
not the primary pen/palm classifier. In particular, a large ordinary finger
must not be rejected from native scrolling merely because its contact geometry
is large.

## Event handling contract

### Pointer Events

- `pointerdown` on an annotatable page claims pen ink only when the selected
  tool consumes ink. It records the pen ID and uses pointer capture when the
  surface supports it. UI targets are excluded before claiming.
- `pointermove` appends samples only for the matching claimed pen ID. Coalesced
  samples are feature-detected and may improve a real stroke; predicted samples
  are preview-only and are never persisted as confirmed geometry.
- `pointerup`, `pointercancel`, and `lostpointercapture` are all terminal paths.
  None may leave a pen ID, capture, or wet stroke ownership behind.
- Touch pointer events are tracked for bounded accounting and passed to the
  native viewer without `preventDefault()` unless an explicitly supported
  touch-only drawing mode owns that contact.

### Touch Events

Touch Events are not a second gesture engine. In normal operation they are
passive, bounded lifecycle/compatibility observations only. They may activate a
fallback path only after capability detection proves Pointer Events unavailable
or materially unusable. A fallback must be generation-scoped and must not run
alongside the Pointer Events path for the same contact.

The implementation must not apply `touch-action: none` to the whole PDF/ink
surface. The default hit-tested surface preserves native one-finger navigation,
two-finger pinch, and momentum. Any narrower temporary guard must be justified
by a measured platform defect, scoped to the smallest element, and covered by
an iPad trace.

## Lifecycle and diagnostics

All terminal and lifecycle cleanup paths call the same state reset operation:
`pointerup`, `pointercancel`, `lostpointercapture`, `blur`, `visibilitychange`,
app background, viewer/session destroy, and generation replacement. Resetting
must release captures, clear the pen ID, clear touch IDs, and invalidate stale
callbacks without synthesizing a replacement gesture.

The diagnostic profile is local, debug-gated, and bounded to a ring of the last
50–100 transitions plus one summary. It records transition source, generation,
pointer ID/type, target class, owner before/after, active counts, capture
set/lost counts, cancellation reason, coalesced/predicted sample counts, and
whether duplicate-looking Pointer/Touch contacts were observed. It never stores
per-move floods, annotation contents, or raw coordinates as durable telemetry.

## Module boundaries

- `PointerRouter.ts` is the single Pointer Events entry point and emits semantic
  actions (`BEGIN_PEN_INK`, `APPEND_PEN_INK`, `END_PEN_INK`, `CANCEL_PEN_INK`,
  `PASS_NATIVE_TOUCH`, and mouse actions).
- `PointerCapabilities.ts` owns feature detection and sample extraction only:
  Pointer Events, capture, coalesced events, predicted events, and observed
  stylus capability. It does not decide ownership.
- `ActiveTouches.ts` (or its replacement) is the one canonical touch-ID store;
  no second set may silently classify the same contact.
- `PalmRejectionPolicy.ts` is limited to ambiguous/touch-only policy and bounded
  evidence. Active recognized-pen ownership already makes a touch non-ink.
- `ViewerMousePan.ts` owns only explicitly configured mouse pan. It must not
  route Pencil through mouse pan or create a competing touch gesture engine.
- `annotationInputPolicy.ts` remains declarative: selected tool, pointer type,
  target class, explicit touch-draw mode, and stylus capability are inputs; it
  has no mutable gesture state.
- `ViewerInkSession.ts` owns rendering, stroke lifecycle, persistence, page
  mapping, and teardown. It does not independently classify contacts.

## Deterministic test boundary

Automated tests must cover pen down/move/up, coalesced sample ordering,
predicted-sample exclusion, finger navigation, two-finger native pinch
classification, a finger arriving during a pen stroke, cancel/lost capture,
blur/destroy/generation cleanup, UI-target exclusion, duplicate pen IDs, and
Pointer/Touch observation without duplicate actions. They must also cover mouse
pan versus mouse ink and the Pointer Events capability-disabled fallback.

These tests do **not** certify hardware behavior. The release gate remains a
physical Obsidian iPadOS/WKWebView trace for:

1. normal and rapid Apple Pencil re-contact;
2. Pencil leaving page bounds and pointer capture loss;
3. Pencil hover, pressure, tilt, and Scribble/text-field interaction;
4. one-finger scroll and two-finger native pinch;
5. palm before and during a Pencil stroke;
6. Pencil during an active finger gesture;
7. toolbar/UI Pencil taps;
8. cancel, background, suspend, rotation, reload, and plugin unload.

Record the Obsidian/plugin/runtime version, device, event ordering, and bounded
profile. Leave rows explicitly `not-run` when hardware evidence is unavailable;
unit-test success must not promote them.

## Delivery phases

1. **Instrument:** bounded transition/capability/capture/lifecycle evidence and
   a Pointer/Touch duplicate detector; remove no fallback yet.
2. **Centralize:** make Pointer Events authoritative, use one ownership state and
   one touch-ID set, and preserve native touch pass-through.
3. **Promote stylus:** let selected pen tools accept confirmed stylus input while
   retaining safe touch-only and mouse fallbacks.
4. **Remove redundancy:** delete superseded PenPresence/ActiveTouches/palm or
   manipulation state only after automated tests and the physical matrix show
   no duplicate processing and unchanged native pinch/scroll behavior.

Until the physical matrix is complete, compatibility fallbacks and unresolved
WebKit behavior remain explicit validation gaps rather than support claims.
