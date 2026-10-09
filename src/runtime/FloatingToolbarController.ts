import type { FloatingToolbarPosition, ToolbarOrientation } from "../model";
import { createDetachedDiv, createDetachedEl } from "../vendor/createDetached";
import { setElementCssProps } from "../dom/typeGuards";
import { resolveFloatingToolbarPosition } from "./FloatingToolbarPosition";

export interface FloatingToolbarControllerOptions {
  host: HTMLElement;
  toolbar: HTMLElement;
  initialPosition: FloatingToolbarPosition | null;
  getOrientation: () => ToolbarOrientation;
  onPositionPersist?: (position: FloatingToolbarPosition) => void;
}

/**
 * Owns mounting the shared AnnotationToolbar into a document-level fixed portal
 * outside viewer clipping/transforms, dragging within viewport bounds,
 * orientation classes, and position persistence.
 */
export class FloatingToolbarController {
  private handle: HTMLButtonElement | null = null;
  private abort: AbortController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private portal: HTMLDivElement | null = null;
  private visibilityObserver: IntersectionObserver | null = null;
  private dragActive = false;
  private position: FloatingToolbarPosition | null = null;
  private destroyed = false;

  constructor(private readonly options: FloatingToolbarControllerOptions) {
    this.position = options.initialPosition ? { ...options.initialPosition } : null;
  }

  getPortal(): HTMLDivElement | null {
    return this.portal;
  }

  getPosition(): FloatingToolbarPosition | null {
    return this.position ? { ...this.position } : null;
  }

  isDragActive(): boolean {
    return this.dragActive;
  }

  isToolbarInPortal(toolbar = this.options.toolbar): boolean {
    return toolbar.isConnected && Boolean(this.portal?.contains(toolbar));
  }

  setPosition(position: FloatingToolbarPosition): void {
    this.position = { ...position };
    if (this.destroyed || this.dragActive) return;
    const toolbar = this.options.toolbar;
    if (!toolbar.classList.contains("native-pdf-handwriting-toolbar-floating-fallback")) return;
    this.applyPosition(toolbar, this.position, null);
  }

  applyOrientation(toolbar = this.options.toolbar): boolean {
    const orientation = this.options.getOrientation();
    const changed = toolbar.classList.contains("is-vertical") !== (orientation === "vertical");
    toolbar.classList.toggle("is-vertical", orientation === "vertical");
    toolbar.classList.toggle("is-horizontal", orientation === "horizontal");
    return changed;
  }

  mount(toolbar = this.options.toolbar): void {
    if (this.destroyed) return;
    const alreadyFloating = toolbar.classList.contains("native-pdf-handwriting-toolbar-floating-fallback");
    this.applyOrientation(toolbar);
    toolbar.classList.add("native-pdf-handwriting-toolbar-floating-fallback");
    toolbar.classList.remove("is-main", "is-sidebar-left", "is-sidebar-right");

    let portal = this.portal;
    if (!portal) {
      portal = createDetachedDiv(toolbar.ownerDocument);
      portal.className = "native-pdf-handwriting-toolbar-portal";
      portal.dataset.focusOverlayInternal = "true";
      portal.setAttribute("aria-hidden", "false");
      this.portal = portal;

      const IntersectionObserverClass = toolbar.ownerDocument.defaultView?.IntersectionObserver;
      if (IntersectionObserverClass) {
        this.visibilityObserver = new IntersectionObserverClass((entries) => {
          const entry = entries.find(({ target }) => target === this.options.host);
          if (!entry || this.portal !== portal) return;
          const visible = entry.isIntersecting && entry.intersectionRatio > 0;
          portal?.classList.toggle("is-owner-view-hidden", !visible);
          portal?.setAttribute("aria-hidden", String(!visible));
        });
        this.visibilityObserver.observe(this.options.host);
      }
    }

    if (!portal.isConnected) {
      const target = toolbar.ownerDocument.body ?? this.options.host;
      target.append(portal);
    }
    if (toolbar.parentElement !== portal) {
      portal.append(toolbar);
    }

    if (!this.handle) {
      const handle = createDetachedEl(toolbar.ownerDocument, "button");
      handle.type = "button";
      handle.className = "native-pdf-handwriting-toolbar-drag-handle";
      handle.textContent = "⠿";
      handle.title = "Move handwriting toolbar";
      handle.setAttribute("aria-label", "Move handwriting toolbar");
      toolbar.prepend(handle);
      this.handle = handle;
      this.installDrag(toolbar, handle);
    }

    const rect = toolbar.getBoundingClientRect();
    this.applyPosition(
      toolbar,
      this.position,
      alreadyFloating ? { left: rect.left, top: rect.top } : null
    );
  }

  private applyPosition(
    toolbar: HTMLElement,
    savedPosition: FloatingToolbarPosition | null,
    currentPosition: FloatingToolbarPosition | null
  ): void {
    const rect = toolbar.getBoundingClientRect();
    const hostRect = this.options.host.getBoundingClientRect();
    const view = toolbar.ownerDocument.defaultView;
    const position = resolveFloatingToolbarPosition({
      savedPosition,
      currentPosition,
      hostPosition: { left: hostRect.left, top: hostRect.top },
      viewport: {
        width: view?.innerWidth ?? hostRect.right,
        height: view?.innerHeight ?? hostRect.bottom
      },
      toolbarSize: { width: rect.width, height: rect.height }
    });
    setElementCssProps(toolbar, {
      left: `${position.left}px`,
      top: `${position.top}px`,
      right: "auto",
      bottom: "auto"
    });
  }

  private installDrag(toolbar: HTMLElement, handle: HTMLButtonElement): void {
    const abort = new AbortController();
    this.abort = abort;
    let drag: { pointerId: number; startX: number; startY: number; left: number; top: number; moved: boolean } | null = null;

    const reapplyPosition = (): void => {
      if (drag || this.dragActive) return;
      const rect = toolbar.getBoundingClientRect();
      this.applyPosition(
        toolbar,
        this.position,
        { left: rect.left, top: rect.top }
      );
    };

    this.resizeObserver?.disconnect();
    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(reapplyPosition);
    this.resizeObserver?.observe(toolbar);
    toolbar.ownerDocument.defaultView?.addEventListener("resize", reapplyPosition, { signal: abort.signal });

    const finish = (event: PointerEvent): void => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const finishedDrag = drag;
      drag = null;
      this.dragActive = false;
      if (handle.hasPointerCapture(event.pointerId)) {
        try {
          handle.releasePointerCapture(event.pointerId);
        } catch {
          /* already released */
        }
      }
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      if (finishedDrag.moved) {
        const rect = toolbar.getBoundingClientRect();
        const newPos = { left: rect.left, top: rect.top };
        this.position = newPos;
        this.options.onPositionPersist?.(newPos);
      } else {
        const rect = toolbar.getBoundingClientRect();
        this.applyPosition(
          toolbar,
          this.position,
          { left: rect.left, top: rect.top }
        );
      }
    };

    handle.addEventListener("pointerdown", (event: PointerEvent) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      const rect = toolbar.getBoundingClientRect();
      const styleLeft = Number.parseFloat(toolbar.style.left);
      const styleTop = Number.parseFloat(toolbar.style.top);
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: Number.isFinite(styleLeft) ? styleLeft : rect.left,
        top: Number.isFinite(styleTop) ? styleTop : rect.top,
        moved: false
      };
      this.dragActive = true;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* pointer capture is optional */
      }
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true, passive: false, signal: abort.signal });

    handle.addEventListener("pointermove", (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const rect = toolbar.getBoundingClientRect();
      const view = toolbar.ownerDocument.defaultView;
      const maxLeft = Math.max(0, (view?.innerWidth ?? rect.right) - rect.width);
      const maxTop = Math.max(0, (view?.innerHeight ?? rect.bottom) - rect.height);
      const left = Math.min(Math.max(drag.left + event.clientX - drag.startX, 0), maxLeft);
      const top = Math.min(Math.max(drag.top + event.clientY - drag.startY, 0), maxTop);
      drag.moved = true;
      setElementCssProps(toolbar, { left: `${left}px`, top: `${top}px` });
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true, passive: false, signal: abort.signal });

    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
      handle.addEventListener(type, finish, { capture: true, passive: false, signal: abort.signal });
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.abort?.abort();
    this.abort = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
    this.portal?.remove();
    this.portal = null;
    this.dragActive = false;
    this.handle?.remove();
    this.handle = null;
    const toolbar = this.options.toolbar;
    toolbar.classList.remove("native-pdf-handwriting-toolbar-floating-fallback");
    toolbar.style.removeProperty("left");
    toolbar.style.removeProperty("top");
    toolbar.style.removeProperty("right");
    toolbar.style.removeProperty("bottom");
    toolbar.classList.remove("is-horizontal", "is-vertical");
  }
}
