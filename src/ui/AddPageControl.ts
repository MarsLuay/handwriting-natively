import { queryPdfPageNodes } from "../integration/pdfPageSelectors";
import { createDetachedEl } from "../vendor/createDetached";

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
}

/**
 * Explicit page-end control. It is deliberately mounted outside the PDF page
 * shell so normal scroll, selection, and pen routing remain native.
 */
export class AddPageControl {
  private readonly abort = new AbortController();
  private readonly button: HTMLButtonElement;
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
    if (!this.callbacks.enabled()) {
      this.button.remove();
      return;
    }
    const lastPage = resolveLastPdfPage(this.callbacks.host());
    const parent = lastPage?.parentElement;
    if (!lastPage || !parent) {
      this.button.remove();
      return;
    }
    if (this.button.parentElement !== parent || this.button.previousElementSibling !== lastPage) {
      parent.insertBefore(this.button, lastPage.nextSibling);
    }
    this.updateState();
  }

  destroy(): void {
    this.abort.abort();
    this.button.remove();
    this.committing = false;
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
