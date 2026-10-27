import { isElement, isHTMLElement } from "../dom/typeGuards";
import {
  findPdfContentContainer,
  findPdfSidebarContainer,
  mutationTogglesPdfSidebarOpen
} from "./PdfSidebarRailOffset";
import type { LayoutWorkTrace, LayoutOperationResult } from "../runtime/LayoutWorkTrace";

export interface PdfSidebarLayoutObserverOptions {
  host: HTMLElement;
  getLayoutScope: () => ParentNode;
  onLayout: (trigger: string) => void;
  eventBus?: {
    on?(event: string, handler: (...args: unknown[]) => void): void;
    off?(event: string, handler: (...args: unknown[]) => void): void;
  } | null | undefined;
  getChromeElement?: (() => HTMLElement | null) | undefined;
  layoutTrace?: LayoutWorkTrace | undefined;
  reportLayoutResult?: ((result: LayoutOperationResult | null) => void) | undefined;
  resizeDeltaGatePx?: number | undefined;
}

/**
 * Shared layout and sidebar observer for PDF views.
 *
 * Monitors PDF content and sidebar containers via MutationObserver, ResizeObserver,
 * EventBus events, and user interactions, triggering layout recalculation when
 * sidebar visibility or dimensions change.
 */
export class PdfSidebarLayoutObserver {
  private readonly options: PdfSidebarLayoutObserverOptions;
  private readonly cleanups: Array<() => void> = [];
  private readonly sidebarResizeSnapshots = new WeakMap<Element, { width: number; height: number }>();
  private installed = false;

  constructor(options: PdfSidebarLayoutObserverOptions) {
    this.options = options;
  }

  install(): void {
    if (this.installed) return;
    this.installed = true;
    const { host, getLayoutScope, onLayout, layoutTrace, reportLayoutResult } = this.options;
    const scope = getLayoutScope();
    const content = findPdfContentContainer(scope);
    const sidebar = findPdfSidebarContainer(scope);

    const classHosts = [content, sidebar, host, isElement(scope) ? scope : null]
      .filter((node): node is HTMLElement => isHTMLElement(node));
    if (classHosts.length > 0) {
      const watched = new Set(classHosts);
      const observer = new MutationObserver((records) => {
        const operation = layoutTrace?.start("sidebar-observer", "mutation");
        try {
          if (!records.some((record) => isHTMLElement(record.target) && watched.has(record.target))) {
            return;
          }
          onLayout(
            mutationTogglesPdfSidebarOpen(records) ? "mutation-sidebar-open" : "mutation"
          );
        } finally {
          if (operation) reportLayoutResult?.(operation.finish());
        }
      });
      for (const h of new Set(classHosts)) {
        observer.observe(h, {
          attributes: true,
          attributeFilter: ["class", "style"],
          attributeOldValue: true
        });
      }
      this.cleanups.push(() => observer.disconnect());
    }

    if (typeof ResizeObserver !== "undefined") {
      const resizeGate = this.options.resizeDeltaGatePx ?? 1.5;
      const resize = new ResizeObserver((entries) => {
        let changed = false;
        for (const entry of entries) {
          const next = {
            width: entry.contentRect.width,
            height: entry.contentRect.height
          };
          const previous = this.sidebarResizeSnapshots.get(entry.target);
          this.sidebarResizeSnapshots.set(entry.target, next);
          if (!previous
            || Math.abs(next.width - previous.width) >= resizeGate
            || Math.abs(next.height - previous.height) >= resizeGate) {
            changed = true;
          }
        }
        if (!changed) return;
        const operation = layoutTrace?.start("sidebar-observer", "resize");
        try {
          onLayout("resize");
        } finally {
          if (operation) reportLayoutResult?.(operation.finish());
        }
      });
      if (sidebar) resize.observe(sidebar);
      const chromeEl = this.options.getChromeElement?.() ?? host.querySelector(".native-pdf-handwriting-chrome");
      if (isHTMLElement(chromeEl)) resize.observe(chromeEl);
      this.cleanups.push(() => resize.disconnect());
    }

    const eventBus = this.options.eventBus;
    for (const event of ["sidebarviewchanged", "togglesidebar"] as const) {
      const handler = (): void => onLayout(event);
      eventBus?.on?.(event, handler);
      this.cleanups.push(() => eventBus?.off?.(event, handler));
    }

    const onClick = (): void => onLayout("click");
    host.addEventListener("click", onClick, true);
    this.cleanups.push(() => host.removeEventListener("click", onClick, true));
  }

  disconnect(): void {
    if (!this.installed) return;
    this.installed = false;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }
}
