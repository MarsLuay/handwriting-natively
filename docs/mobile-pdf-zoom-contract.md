# Mobile PDF pan and pinch contract

The plugin may own touch navigation only for a live PDF page whose platform,
viewer profile, pointer/touch capabilities, page identity, and geometry all pass
`planMobileCustomPdfZoom`. The setting is enabled by default on iOS, iPadOS,
and Android hosts and can be turned off to return gestures to the host.
Desktop, image, Markdown, unknown-platform, and unsafe-page paths keep native
gestures.

`PointerRouter` leaves host-owned targets alone and passes eligible page
contacts to the session's shared `GestureNavigationController`. One finger pans
through `HandwritingViewport`; two fingers translate with their moving midpoint
before scaling around that focal point. Touch drawing remains opt-in. If a
second finger arrives during an opted-in touch annotation, the active annotation
route is canceled across page routers before the controller owns the pinch. A
committed text box keeps its separate touch-edit route until a multi-touch
navigation gesture is recognized. If a new contact comes from an unqualified
page, or the pinch start fails its live page gate, the controller cancels its
existing custom contacts and any promoted annotation route before returning the
joining contact to native routing. It does not keep one finger in custom pan
while another finger falls through to the host.

`HandwritingViewport` owns the temporary visual projection and reports scale to
the session's canonical view snapshot. The PDF adapter remains the renderer;
the gesture path does not introduce a second PDF renderer or persisted scale
owner. If a custom gesture is canceled because a joining contact is
unqualified, the controller releases captures, resets pinch state, and
suppresses its `touch-action: none` policy until every contact in that sequence
ends. Further contacts during that fallback sequence stay native. Pointer
cancellation, touchend, lifecycle cleanup, and session teardown clear the
temporary policy. Browsers decide `touch-action` when a gesture starts, so
changing the policy after a second contact arrives cannot guarantee native
takeover of that same gesture; it prevents a stale lockout and restores native
handling for later gestures. A lost pointer capture does not by itself end a
physical touch.

The capability gate is a safety boundary, not evidence that every physical
device is qualified. iOS, iPadOS, and Android behavior remains pending
named-device verification, especially stylus coexistence, PDF link targets,
page replacement, and resume after backgrounding.
