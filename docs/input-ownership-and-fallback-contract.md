# Cross-platform input ownership and fallback contract

This document is the compatibility contract for Handwriting Natively input.
It describes the behavior shipped by the shared input layer; it is not a
claim that every host has been qualified. Current Obsidian/iPadOS behavior that
requires a physical device remains in the release matrix and the iPad trace
harness.

Related evidence boundaries:

- [Input gesture architecture](input-gesture-architecture.md) describes the
  ownership model and unresolved hardware questions.
- [iPad Pointer/Touch trace harness](ipad-pointer-touch-trace-harness.md)
  records physical Pointer, Touch, Scribble, and lifecycle evidence.
- [PDF runtime validation matrix](pdf-runtime-validation-matrix.md) records
  per-platform release status. A `not-run` row is not support evidence.

## Contract summary

1. Pointer Events are authoritative when the host exposes a usable Pointer
   Events surface.
2. A valid `pointerType === "pen"` contact promotes the session's stylus
   capability to `confirmed`. This is runtime evidence, not a user-agent,
   pressure, radius, or viewport guess.
3. A confirmed pen on a safe page may annotate with the selected ink tool. A
   separate global Draw checkbox is not required for pen input.
4. Ordinary mouse and touch remain native for every selected tool. There is no
   setting that enables mouse or touch annotation.
5. UI targets are excluded before stylus annotation ownership is claimed.
6. Active pen ownership blocks companion touch from scrolling beneath the
   stroke; touch cannot steal pen ownership.
7. Unknown or ambiguous environments fail safe. The plugin does not infer a
   pen from pressure, contact geometry, or user-agent text.

## Ownership states and transitions

`GestureOwnership` is the authoritative contact owner. It tracks the owner,
active pen ID, active touch IDs, mouse pointer/buttons, and a generation
counter.

| Contact and context | Ownership | Default action |
| --- | --- | --- |
| Pen on a safe page with an ink-capable tool | `pen-ink` | Begin/append/finalize ink |
| Touch without an active pen | `native-touch-navigation` | Preserve native scroll/pinch |
| Touch while a pen owns ink | `pen-ink` remains authoritative | Block companion scroll; never ink |
| Mouse input | `idle` | Preserve native PDF behavior |
| Pen or mouse on UI/chrome before a claim | `idle` or existing owner | Leave the UI event available |
| Blur, pagehide, hidden visibility, cancel, destroy, or generation replacement | `idle` for the new generation | Release captures and clear IDs |

Each physical contact has one semantic route. Document-level recovery and page
listeners may observe the same browser event, but the router's handled-event
and consumed-sample guards prevent duplicate starts or appends.

## Capability promotion and fallback

The runtime probes concrete host capabilities through
`detectPointerInputCapabilities`:

| Capability | Meaning |
| --- | --- |
| `pointerEvents` | The normal pointer action stream can be registered |
| `pointerCapture` | The annotation surface can attempt capture/release |
| `touchEvents` | Touch events are available for native observation or compatibility |

The probe does not use a user-agent or viewport guess. Missing optional
capabilities do not disable a page whose identity and geometry are safe.

### Pointer Events available

`PointerRouter` classifies stylus input and emits annotation actions. Touch
listeners only block companion scrolling during active stylus contact, track
lifecycle state, and collect diagnostics. They are not a drawing or navigation
engine.

### Pointer Events unavailable

The router does not synthesize pointer contacts from Touch Events. Touch and
mouse remain native. Stylus annotation is available only when the host exposes
a supported stylus event path; the plugin does not guess from pressure,
contact geometry, or platform labels.

## Pointer and sample guarantees

### Pen input

- `pointerdown` on a safe page claims the pen ID for the selected ink-capable
  tool and attempts pointer capture when available.
- `pointermove` appends only for the matching owned ID.
- Pen coalesced samples are feature-detected, kept in timestamp order, and
  bounded before they reach the stroke path.
- Hover or near-zero-pressure move samples do not create confirmed ink.
- `pointerup`, `pointercancel`, document terminal recovery, and lifecycle
  cleanup release ownership and clear stale state.

### Coalesced samples

`PointerCapabilities.samples()` consumes real coalesced pen samples when the
host exposes them. The current cap is `MAX_POINTER_BATCH_SAMPLES` (64). The
final dispatched sample is appended when it differs from the coalesced tail so
the canonical stroke includes the actual browser endpoint.

### Predicted samples

`getPredictedEvents()` is optional and feature-detected. Predicted samples are
bounded by `MAX_PREDICTED_POINTER_SAMPLES` (24) and sent only to the ephemeral
wet-ink preview callback. They are never included in canonical move samples,
stroke builders, history, sidecars, exports, or undo/redo state. Removing
predictions must not change persisted geometry.

## Touch-action and palm policy

The plugin does not apply `touch-action: none` globally to a PDF or ink
surface. Native one-finger scrolling and two-finger pinch remain available.

While a pen is actively owned, the page may receive a transient scoped guard
to prevent companion touch from scrolling the document underneath the stroke.
The guard is removed when the pen ends, cancels, or is cleared by lifecycle
recovery. It is not a permanent Draw-mode lock.

Active pen ownership is the primary palm rule: touch is non-ink regardless of
width, height, radius, or pressure. Geometry can be retained as bounded
diagnostic evidence, but it is not a cross-platform pen classifier. A large
ordinary finger must remain eligible for native navigation when no pen owns the
gesture.

## Mouse and tool behavior

Mouse input never starts annotation and remains available to the host PDF
viewer regardless of selected tool or legacy settings.

The selected tool controls the semantic route for confirmed stylus input:

- Pen, Pencil, and Highlighter use the pen ink path.
- Eraser and Lasso use the edit path.
- Text uses the text path when its target is eligible.

Tool selection is not a substitute for capability detection, and capability
detection is not permission to change native touch behavior.

## Platform compatibility matrix

| Runtime | Preferred contract | Safe fallback/default | Physical qualification required |
| --- | --- | --- | --- |
| iPadOS + Apple Pencil | Pointer Events; confirmed pen annotates, finger stays native | Native touch and mouse | Pencil hover/pressure/tilt, Scribble, Pointer/Touch ordering, page boundaries, native pinch, background/reload |
| Android + active stylus | Pointer Events with `pointerType === "pen"` when exposed | Native touch and mouse | Host WebView delivery, stylus fields, pinch, replacement, resume |
| Windows/Surface pen | Pointer Events pen ownership | Native touch and mouse | Real pen pressure/tilt, capture, page boundary, host viewer lifecycle |
| Touch-only mobile | Native one-/two-finger navigation | Native touch and mouse; annotation unavailable without confirmed stylus | Touch navigation, `touch-action` placement, background/resume |
| Desktop mouse/trackpad | Native mouse and trackpad behavior | Native mouse and trackpad behavior | Host PDF page hit behavior and trackpad gesture interaction |
| Unknown or ambiguous host | Do not guess; preserve native behavior and fail closed on unsafe page evidence | No implicit pen promotion | A named host/device run before making a support claim |

The table describes policy, not a hardware qualification result. Supported
platform labels in a release record must link to a current row in the runtime
validation matrix.

## Evidence boundary

The deterministic test suite can prove state transitions, route decisions,
sample caps, duplicate suppression, and cleanup. It cannot
prove WebKit delivery, Apple Pencil hover, real pressure/tilt, Scribble
interception, native PDF pinch ownership, or app suspension timing.

Those claims require a named Obsidian build, plugin version, OS version,
device, display scale/refresh rate, copied bounded trace, and a result for
every applicable row in `ipad-pointer-touch-trace-harness.md`. Until that
evidence exists, keep the row `not-run` or `blocked`; do not promote it from
synthetic tests or a different platform.

When implementation and documentation disagree, the current code and its
deterministic tests are authoritative for shipped behavior. Update this
contract with the same change that changes the policy; keep physical findings
in the trace/release record rather than encoding them as runtime guesses.
