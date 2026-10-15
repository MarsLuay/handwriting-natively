# Input ownership architecture (#130)

This document describes the deterministic input policy in Handwriting Natively.
It does not claim that synthetic DOM tests reproduce WebKit, Scribble, Apple
Pencil hover, or native PDF gestures on a physical device.

## Ownership

Confirmed stylus input annotates by default. Mouse annotation and one-finger
drawing are separate opt-in settings; touch drawing is unavailable after a
confirmed stylus is observed. A finger can still edit a committed text box
when touch drawing is off. While a stylus is active, companion touch is blocked
from scrolling the document beneath the stroke.

`GestureOwnership` tracks stylus and opted-in mouse annotation contacts.
`GestureNavigationController` handles stylus hand-pan, active-stylus
companion-touch blocking, and qualified mobile PDF pan/pinch. The controller
leaves unsupported surfaces with native touch behavior.

```ts
type InputOwner = "idle" | "pen-ink" | "mouse-ink";

interface ActiveInputState {
  owner: InputOwner;
  activePenId: number | null;
  generation: number;
}
```

| Current owner | Incoming contact | Result |
| --- | --- | --- |
| `idle` | confirmed pen on a safe page with an ink-capable tool | claim `pen-ink` |
| `idle` | mouse with mouse annotation enabled and native-selection mode off | claim `mouse-ink` |
| `idle` | other mouse input | preserve native host behavior |
| `idle` | touch with touch drawing enabled and no confirmed stylus | route through the selected tool |
| `idle` | other touch input | native navigation or the qualified mobile PDF gesture controller |
| `pen-ink` | matching pen move/up | append/finalize ink, then release |
| `pen-ink` | matching pen cancel/lost capture | cancel safely; retain pen exclusion until terminal or stale-pen recovery |
| `pen-ink` | companion touch | block scrolling; never claim annotation ownership |
| any | UI target before a gesture is claimed | leave the UI event alone |
| any | blur, background, destroy, or generation replacement | clear contact and capture state |

Width, height, radius, or pressure may be recorded as diagnostics, but they are
not the primary pen classifier. A large finger must not be rejected from native
scrolling because of its contact geometry.

## Event handling

### Pointer Events

- `PointerRouter` starts pen annotation on a safe page. Primary mouse annotation
  requires its opt-in setting; touch drawing requires its opt-in setting and no
  confirmed stylus evidence.
- Pen moves append samples only for the matching owned ID. Coalesced samples
  are bounded and ordered; predicted samples are preview-only and never
  persisted.
- `pointerup`, `pointercancel`, lifecycle cancellation, and generation
  replacement release ownership. `lostpointercapture` alone does not end pen
  exclusion.
- Mouse and touch events remain available to the host unless their annotation
  setting is enabled, a qualified mobile PDF gesture is active, or companion
  touch must be blocked during active stylus contact. Committed text boxes have
  a narrow touch-edit route even when touch drawing is off.

### Touch Events

Touch Events do not cancel ordinary taps. They support companion-touch
blocking, terminal bookkeeping, and non-canceling double-tap recognition. The
recognizer rejects multi-touch contacts, canceled contacts, long presses, and
contacts that move far enough to become navigation. A completed one-finger
double-tap switches between the eraser and the previous tool.

Pointer Events drive optional touch drawing and the qualified mobile PDF
gesture controller. On eligible mobile PDF pages the controller pans with one
finger and pinches around the moving midpoint with two fingers, applying the
midpoint translation before focal-point scaling. Unknown or unsafe viewers,
non-PDF surfaces, and disabled settings retain native gestures.

The plugin applies `touch-action: none` only to a page whose live PDF, platform,
pointer, touch, identity, geometry, and lifecycle evidence passes the mobile
navigation gate, or while a stylus contact needs the companion-touch guard.
Surface teardown restores the prior touch policy.

## Navigation and zoom boundaries

- `GestureNavigationController` owns stylus hand-pan, active-stylus companion
  touch blocking, and the qualified mobile PDF pan/pinch path.
- PDF modifier-wheel zoom stays in `PdfJsViewAdapter`.
- Image scale and viewport projection stay in `ViewerInkSession` and
  `HandwritingViewport`.
- Unsupported mouse, touch, trackpad, link, search, and text-selection behavior
  remains with Obsidian or the host viewer. Custom PDF gestures are not enabled
  for non-PDF surfaces or uncertain hosts.

One `PhysicalContactCollector` listener set may be leased by multiple viewer
hosts in the same document; it dispatches each event only to the matching host
owner. The listeners may remain registered while any owner lease is active,
but tracking and callbacks stay disabled when diagnostics are off. The
collector is an observer, not an input-correctness dependency. Document/host
ownership and page-router ownership remain separate safeguards.

## Device evidence

The diagnostic profile is local, debug-gated, and bounded. It records contact
transitions, ownership, generation, capture, and cancellation evidence without
persisting annotation contents, raw movement floods, or durable coordinates.
The iPad-only passive observer and physical run matrix live in
`docs/ipad-pointer-touch-trace-harness.md`.

The deterministic test suite can prove routing decisions, sample caps,
duplicate suppression, cleanup, and ownership boundaries. It cannot prove
WebKit event delivery, Apple Pencil hover, real pressure/tilt, Scribble
interception, native PDF pinch behavior, or app suspension timing. Keep physical
device rows `not-run` or `blocked` until a named Obsidian build, OS, device, and
bounded trace provide evidence.
