# Input gesture ownership architecture (#130)

This document is the implementation boundary for pen, finger, palm, mouse, and
native PDF gestures. It records the deterministic policy that can be tested in
this repository and the evidence that still requires Obsidian on physical
iPadOS hardware. It does not claim that synthetic DOM tests reproduce WebKit,
Scribble, Apple Pencil hover, or native PDF pinch behavior.

## Authority and ownership

Pointer Events are the authoritative input stream whenever the runtime exposes a
usable Pointer Events surface. Annotation ownership and navigation ownership
have separate state: `GestureOwnership` tracks annotation contacts, while the
session's shared `GestureNavigationController` owns navigation movement and
zoom. A physical contact must not be moved by both controllers.

```ts
type InputOwner =
  | "idle"
  | "pen-ink"
  | "mouse-ink";

interface ActiveInputState {
  owner: InputOwner;
  activePenId: number | null;
  activeMouseButtons: number;
  generation: number;
}
```

`GestureNavigationController` tracks navigation pointer IDs across the page
routers in one viewer session. The stroke session owns stroke lifecycle and
page-coordinate conversion; it consumes routed semantic actions rather than
reclassifying a pointer as pen, finger, or palm. A router generation invalidates
callbacks from a replaced or destroyed viewer.

### Transition policy

| Current owner | Incoming contact | Result |
| --- | --- | --- |
| `idle` | pen down, ink-capable tool, annotatable page | claim `pen-ink` |
| `idle` | finger down | controller owns pan when custom mobile navigation is qualified; otherwise leave it native |
| `idle` | mouse draw gesture | claim `mouse-ink` |
| `idle` | mouse input disabled or non-primary button | leave the native event available |
| `pen-ink` | matching pen move/up | append/finalize ink, then release |
| `pen-ink` | matching pen cancel/lost capture | cancel safely, then release |
| `pen-ink` | finger/palm contact | observe/track only; never transfer ink ownership |
| controller-owned touch | second finger | controller owns two-finger pan and pinch when qualified; otherwise preserve native pinch/pan |
| active pen | companion finger | block the companion navigation candidate until a real terminal or stale-pen recovery |
| hand tool | primary mouse/pen or touch movement | controller owns pan and capture cleanup |
| any | UI target before a gesture is claimed | leave the UI event alone |
| any | blur, background, destroy, or generation replacement | clear every contact and capture |

A recognized active pen may annotate with the selected ink tool without a
separate Draw checkbox. Finger input remains navigation. Primary-button mouse
inking is controlled by one explicit setting; disabled mouse input remains
native because `pointerType="mouse"` does not identify the user's intent. A
`lostpointercapture` event alone does not clear active-pen exclusion.

Width, height, radius, or pressure may be recorded as diagnostics, but they are
not the primary pen/palm classifier. In particular, a large ordinary finger
must not be rejected from native scrolling merely because its contact geometry
is large.

## Event handling contract

### Pointer Events

- `pointerdown` on an annotatable page claims pen ink only when the selected
  tool consumes ink. It records the pen ID and uses pointer capture when the
  surface supports it. UI targets are excluded before claiming. Touch and hand
  movement is delegated to the session's navigation controller.
- `pointermove` appends samples only for the matching claimed pen ID. Coalesced
  samples are feature-detected and may improve a real stroke; predicted samples
  are preview-only and are never persisted as confirmed geometry.
- `pointerup`, `pointercancel`, and lifecycle cancellation release input. A
  `lostpointercapture` event ends capture ownership but leaves the pen exclusion
  guard until a real terminal or bounded stale-pen recovery.
- Eligible mobile touch pointer events are handled by the navigation
  controller. It waits for the existing movement threshold before one-finger
  pan and owns two-finger pan/pinch through the session compositor. Unsupported
  modes retain browser navigation without `preventDefault()`.

### Touch Events

Touch Events do not create a competing movement owner. The navigation
controller uses them to reconcile terminal contacts and to recover a two-finger
gesture when WKWebView omits the promoting PointerEvent. The fallback is scoped
to the active page and does not process movement already claimed by the Pointer
Events path.

The implementation must not apply `touch-action: none` to the whole PDF/ink
surface. The default hit-tested surface preserves native one-finger navigation,
two-finger pinch, and momentum. Any narrower temporary guard must be justified
by a measured platform defect, scoped to the smallest element, and covered by
an iPad trace.

## Lifecycle and diagnostics

Terminal and lifecycle cleanup releases captures and touch contacts through the
navigation controller. `pointerup`, `pointercancel`, blur, visibility change,
app background, viewer/session destroy, and generation replacement clear the
active-pen guard; `lostpointercapture` alone preserves it until the real
terminal or bounded stale-pen recovery. Cleanup never synthesizes a replacement
gesture.

The diagnostic profile is local, debug-gated, and bounded to a ring of the last
50–100 transitions plus one summary. It records transition source, generation,
pointer ID/type, target class, owner before/after, active counts, capture
set/lost counts, cancellation reason, coalesced/predicted sample counts, and
whether duplicate-looking Pointer/Touch contacts were observed. It never stores
per-move floods, annotation contents, or raw coordinates as durable telemetry.

The iPad-only passive observer and physical run matrix live in
`docs/ipad-pointer-touch-trace-harness.md`. It captures the real Obsidian
viewer/UI/Scribble ordering without participating in routing.

## Module boundaries

- `PointerRouter.ts` is the page Pointer Events entry point. It emits ink
  actions and delegates touch/hand movement to `GestureNavigationController`.
- `GestureNavigationController.ts` is the single movement owner for eligible
  one-finger pan, two-finger pan/pinch, hand-tool movement, modifier-wheel zoom,
  stylus exclusion, and navigation cleanup. It updates the session viewport or
  PDF scroll root through one callback path. Viewport rubber-band pan settles
  after the final contact ends or the wheel-pan stream becomes idle.
- `PointerCapabilities.ts` owns feature detection and sample extraction only:
  Pointer Events, capture, coalesced events, predicted events, and observed
  stylus capability. It does not decide ownership.
- `PalmRejectionPolicy.ts` owns bounded stylus evidence and stale-pen recovery;
  the navigation controller receives active pen IDs so a companion finger
  cannot become a navigation candidate.
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
Pointer/Touch observation without duplicate actions. They must also cover the
mouse primary-button route, disabled mouse input remaining native, and the
Pointer Events capability-disabled fallback.

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
2. **Centralize:** make Pointer Events authoritative, use one annotation owner
   and one navigation owner, and preserve native touch pass-through when the
   custom navigation path is not eligible.
3. **Promote stylus:** let selected pen tools accept confirmed stylus input while
   retaining safe touch-only and mouse fallbacks.
4. **Remove redundancy:** delete superseded PenPresence/ActiveTouches/palm or
   manipulation state only after automated tests and the physical matrix show
   no duplicate processing and unchanged native pinch/scroll behavior.

Until the physical matrix is complete, compatibility fallbacks and unresolved
WebKit behavior remain explicit validation gaps rather than support claims.
