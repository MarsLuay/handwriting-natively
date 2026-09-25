import { queryPdfPageNodes } from "../integration/pdfPageSelectors";
import { createDetachedEl } from "../vendor/createDetached";

const addPageControlOwners = new WeakMap<HTMLElement, AddPageControl>();
let nextAddPageUiGeneration = 0;

function resolveLastPdfPage(host: HTMLElement): HTMLElement | null {
  const pages = queryPdfPageNodes(host);
  if (pages.length === 0) return null;
  let last = pages[0]!;
  let lastNumber = Number(last.dataset.pageNumber) || 0;
  for (const page of pages.slice(1)) {
    const number = Number(page.dataset.pageNumber) || 0;
    if (number >= lastNumber) {
      last = page;
      lastNumber = number;
    }
  }
  return last;
}

export interface AddPageControlCallbacks {
  enabled(): boolean;
  isBusy(): boolean;
  host(): HTMLElement;
  onCommit(): void | Promise<void>;
  onLifecycle?(phase: "mounted" | "duplicate" | "destroyed", details: Record<string, unknown>): void;
}

/**
 * Explicit page-end control. It is deliberately mounted outside the PDF page
 * shell so normal scroll, selection, and pen routing remain native.
 */
export class AddPageControl {
  private readonly abort = new AbortController();
  private readonly button: HTMLButtonElement;
  private readonly uiGeneration = ++nextAddPageUiGeneration;
  private mountedHost: HTMLElement | null = null;
  private reportedHost: HTMLElement | null = null;
  private committing = false;

  constructor(
    private readonly callbacks: AddPageControlCallbacks,
    ownerDocument: Document
  ) {
    this.button = createDetachedEl(ownerDocument, "button");
    this.button.type = "button";
    this.button.className = "native-pdf-handwriting-add-page";
    this.button.setAttribute("aria-label", "Add page");
    this.button.textContent = "+ add page";
    this.button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.commit();
    }, { signal: this.abort.signal });

    this.refresh();
  }

  refresh(): void {
    const host = this.callbacks.host();
    const previous = addPageControlOwners.get(host);
    if (previous && previous !== this) previous.destroy("replaced");
    if (this.mountedHost && this.mountedHost !== host && addPageControlOwners.get(this.mountedHost) === this) {
      addPageControlOwners.delete(this.mountedHost);
    }
    addPageControlOwners.set(host, this);
    this.mountedHost = host;

    if (!this.callbacks.enabled()) {
      this.button.remove();
      return;
    }
    const existingControls = [...host.querySelectorAll<HTMLButtonElement>(".native-pdf-handwriting-add-page")]
      .filter((control) => control !== this.button);
    const controlCountBefore = existingControls.length + (this.button.isConnected ? 1 : 0);
    const duplicateControlIds = [this.button, ...existingControls]
      .filter((control) => control.isConnected)
      .slice(0, 8)
      .map(addPageControlId);
    if (existingControls.length > 0) {
      for (const control of existingControls) control.remove();
    }
    this.button.dataset.nativePdfHandwritingUiGeneration = String(this.uiGeneration);
    const lastPage = resolveLastPdfPage(host);
    const parent = lastPage?.parentElement;
    if (!lastPage || !parent) {
      this.button.remove();
      return;
    }
    if (this.button.parentElement !== parent || this.button.previousElementSibling !== lastPage) {
      parent.insertBefore(this.button, lastPage.nextSibling);
    }
    if (controlCountBefore > 1) {
      this.callbacks.onLifecycle?.("duplicate", {
        surface: "bottom",
        uiGeneration: this.uiGeneration,
        controlCountBefore,
        controlCountAfter: host.querySelectorAll(".native-pdf-handwriting-add-page").length,
        expectedControlCount: 1,
        connectedControlIds: duplicateControlIds,
        hostTag: host.tagName.toLowerCase(),
        hostClasses: [...host.classList].slice(0, 6),
        injectionSource: "root-reconciliation"
      });
    }
    if (this.reportedHost !== host) {
      this.reportedHost = host;
      this.callbacks.onLifecycle?.("mounted", {
        surface: "bottom",
        uiGeneration: this.uiGeneration,
        controlCountAfter: host.querySelectorAll(".native-pdf-handwriting-add-page").length,
        expectedControlCount: 1,
        hostTag: host.tagName.toLowerCase(),
        hostClasses: [...host.classList].slice(0, 6),
        injectionSource: "root-reconciliation"
      });
    }
    this.updateState();
  }

  destroy(reason = "destroyed"): void {
    if (this.abort.signal.aborted) return;
    if (this.mountedHost && addPageControlOwners.get(this.mountedHost) === this) {
      addPageControlOwners.delete(this.mountedHost);
    }
    this.abort.abort();
    this.button.remove();
    this.committing = false;
    this.callbacks.onLifecycle?.("destroyed", {
      surface: "bottom",
      uiGeneration: this.uiGeneration,
      reason
    });
  }

  private updateState(): void {
    const busy = this.committing || this.callbacks.isBusy();
    this.button.disabled = busy;
    this.button.setAttribute("aria-busy", busy ? "true" : "false");
  }

  private async commit(): Promise<void> {
    if (this.committing || !this.callbacks.enabled() || this.callbacks.isBusy()) {
      this.updateState();
      return;
    }
    this.committing = true;
    this.updateState();
    try {
      await this.callbacks.onCommit();
    } finally {
      this.committing = false;
      this.refresh();
    }
  }
}

function addPageControlId(control: HTMLButtonElement): string {
  return control.dataset.nativePdfHandwritingUiGeneration ?? (control.id || "unidentified");
}
