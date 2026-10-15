# Input ownership architecture (#130)

This document describes the deterministic input policy in Handwriting Natively.
It does not claim that synthetic DOM tests reproduce WebKit, Scribble, Apple
Pencil hover, or native PDF gestures on a physical device.

## Ownership

Only confirmed stylus input can annotate. Ordinary mouse and touch remain with
Obsidian or the host PDF viewer for every selected tool. While a stylus is
active, companion touch is blocked from scrolling the document beneath the
stroke. There is no mouse-inking or touch-drawing setting.

`GestureOwnership` tracks annotation contacts. `GestureNavigationController`
handles stylus hand-pan and active-stylus companion-touch blocking. These
owners do not capture ordinary mouse or touch navigation.

```ts
type InputOwner = "idle" | "pen-ink";

interface ActiveInputState {
  owner: InputOwner;
  activePenId: number | null;
  generation: number;
}
```

| Current owner | Incoming contact | Result |
| --- | --- | --- |
| `idle` | confirmed pen on a safe page with an ink-capable tool | claim `pen-ink` |
| `idle` | mouse | preserve native host behavior |
| `idle` | touch | preserve native host navigation |
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

- `PointerRouter` starts annotation only for a confirmed pen on a safe page and
  an ink-capable selected tool.
- Pen moves append samples only for the matching owned ID. Coalesced samples
  are bounded and ordered; predicted samples are preview-only and never
  persisted.
- `pointerup`, `pointercancel`, lifecycle cancellation, and generation
  replacement release ownership. `lostpointercapture` alone does not end pen
  exclusion.
- Mouse and touch pointer events remain available to the host viewer unless a
  companion touch must be blocked during active stylus contact.

### Touch Events

Touch Events do not create a drawing, pan, or pinch engine. They support
companion-touch blocking, terminal bookkeeping, and debug diagnostics. The
host retains native one-finger scroll and two-finger pinch behavior.

The plugin does not apply `touch-action: none` to a whole PDF or ink surface.
Any temporary companion-touch guard is scoped to the active stylus stroke and
removed on terminal or lifecycle cleanup.

## Navigation and zoom boundaries

- `GestureNavigationController` handles stylus hand-pan and prevents companion
  touch from scrolling during an active stylus contact.
- PDF modifier-wheel zoom stays in `PdfJsViewAdapter`.
- Image scale and viewport projection stay in `ViewerInkSession` and
  `HandwritingViewport`.
- Native mouse, touch, trackpad, link, search, and text-selection behavior
  remains with Obsidian or the host viewer.

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
