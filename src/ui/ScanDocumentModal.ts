import { Modal, type App } from "obsidian";
import {
  canvasToScanPage,
  defaultDocumentQuad,
  detectDocumentBoundary,
  renderPerspectiveCrop,
  rotateQuarterTurns,
  type DocumentQuad,
  type ScanDocumentPage,
  type ScanPoint
} from "../scanning/ScanDocument";
import { createDetachedEl } from "../vendor/createDetached";

type Corner = keyof DocumentQuad;

const CORNERS: readonly Corner[] = ["topLeft", "topRight", "bottomRight", "bottomLeft"];

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function cornerLabel(corner: Corner): string {
  return corner.replace(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase());
}

/** WebView-compatible camera capture and in-memory document review flow. */
export class ScanDocumentModal extends Modal {
  private readonly abort = new AbortController();
  private readonly resolveResult: (result: readonly ScanDocumentPage[] | null) => void;
  private captureInput: HTMLInputElement | null = null;
  private currentImage: HTMLImageElement | null = null;
  private currentObjectUrl: string | null = null;
  private currentQuad: DocumentQuad = defaultDocumentQuad();
  private currentRotation = 0;
  private completedPages: ScanDocumentPage[] = [];
  private preview: HTMLElement | null = null;
  private reviewBody: HTMLElement | null = null;
  private draggingCorner: Corner | null = null;
  private settled = false;
  private busy = false;

  private get ownerDocument(): Document {
    return this.contentEl.ownerDocument ?? activeDocument;
  }

  constructor(app: App, resolveResult: (result: readonly ScanDocumentPage[] | null) => void) {
    super(app);
    this.resolveResult = resolveResult;
  }

  onOpen(): void {
    this.titleEl.textContent = "Scan document";
    this.reviewBody = this.contentEl.createDiv({ cls: "native-pdf-handwriting-scan-body" });
    this.captureInput = this.contentEl.createEl("input", { type: "file" });
    this.captureInput.accept = "image/*";
    this.captureInput.setAttribute("capture", "environment");
    this.captureInput.className = "native-pdf-handwriting-scan-input";
    this.captureInput.addEventListener("change", () => this.captureSelectedFile(), { signal: this.abort.signal });
    this.captureInput.addEventListener("cancel", () => this.showCaptureMessage("Camera capture was canceled or permission was denied."), { signal: this.abort.signal });
    this.renderCaptureState();
    // The click is intentionally action-time: the plugin never requests camera
    // access while it is loading or attaching a PDF view.
    this.openCameraCapture();
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolveResult(null);
    }
    this.abort.abort();
    this.clearCurrentImage();
    this.captureInput = null;
    this.preview = null;
    this.reviewBody = null;
    this.contentEl.replaceChildren();
  }

  private openCameraCapture(): void {
    const input = this.captureInput;
    if (!input || this.busy || this.settled) return;
    input.value = "";
    input.click();
  }

  private renderCaptureState(message?: string): void {
    const body = this.reviewBody;
    if (!body) return;
    body.replaceChildren();
    body.createEl("p", {
      text: message ?? (this.completedPages.length
        ? "Capture the next document page, or cancel to discard the scan."
        : "Capture a document page with the rear camera.")
    });
    const capture = body.createEl("button", {
      text: this.completedPages.length ? "Capture another page" : "Capture page",
      cls: "mod-cta"
    });
    capture.addEventListener("click", () => this.openCameraCapture(), { signal: this.abort.signal });
    const cancel = body.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.cancel(), { signal: this.abort.signal });
  }

  private showCaptureMessage(message: string): void {
    if (this.settled) return;
    if (!this.currentImage) {
      this.renderCaptureState(message);
      return;
    }
    const error = createDetachedEl(this.ownerDocument, "p");
    error.className = "native-pdf-handwriting-scan-error";
    error.textContent = message;
    this.reviewBody?.prepend(error);
  }

  private captureSelectedFile(): void {
    const file = this.captureInput?.files?.[0];
    if (!file) return;
    this.clearCurrentImage();
    const urlApi = this.ownerDocument.defaultView?.URL ?? URL;
    this.currentObjectUrl = urlApi.createObjectURL(file);
    const image = createDetachedEl(this.ownerDocument, "img");
    image.alt = "Captured document preview";
    image.className = "native-pdf-handwriting-scan-image";
    image.addEventListener("load", () => this.prepareReview(image), { signal: this.abort.signal });
    image.addEventListener("error", () => {
      this.clearCurrentImage();
      this.showCaptureMessage("The captured image could not be opened. Try again.");
    }, { signal: this.abort.signal });
    image.src = this.currentObjectUrl;
    this.currentImage = image;
  }

  private prepareReview(image: HTMLImageElement): void {
    if (this.settled || this.currentImage !== image) return;
    this.currentQuad = this.detectBoundary(image);
    this.currentRotation = 0;
    this.renderReview();
  }

  private detectBoundary(image: HTMLImageElement): DocumentQuad {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    try {
      const canvas = createDetachedEl(this.ownerDocument, "canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      const data = context && width > 0 && height > 0 ? context.getImageData(0, 0, width, height) : undefined;
      return detectDocumentBoundary(width, height, data ?? undefined);
    } catch {
      return defaultDocumentQuad();
    }
  }

  private renderReview(): void {
    const body = this.reviewBody;
    const image = this.currentImage;
    if (!body || !image) return;
    body.replaceChildren();
    body.createEl("p", { text: "Review the detected page boundary. Drag the corners to correct the perspective crop." });
    this.preview = body.createDiv({ cls: "native-pdf-handwriting-scan-preview" });
    this.preview.append(image);
    this.preview.addEventListener("pointermove", (event) => this.moveCorner(event), { signal: this.abort.signal });
    this.preview.addEventListener("pointerup", () => { this.draggingCorner = null; }, { signal: this.abort.signal });
    this.preview.addEventListener("pointercancel", () => { this.draggingCorner = null; }, { signal: this.abort.signal });
    for (const corner of CORNERS) {
      const handle = createDetachedEl(this.ownerDocument, "button");
      handle.type = "button";
      handle.className = "native-pdf-handwriting-scan-corner";
      handle.dataset.corner = corner;
      handle.setAttribute("aria-label", `Move ${cornerLabel(corner)} corner`);
      handle.textContent = "•";
      handle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        this.draggingCorner = corner;
      }, { signal: this.abort.signal });
      this.preview.append(handle);
    }
    this.positionCorners();

    const controls = body.createDiv({ cls: "native-pdf-handwriting-scan-controls" });
    const rotate = controls.createEl("button", { text: "Rotate" });
    rotate.addEventListener("click", () => {
      this.currentRotation = rotateQuarterTurns(this.currentRotation);
      rotate.setAttribute("aria-label", `Rotate, ${this.currentRotation * 90} degrees`);
    }, { signal: this.abort.signal });
    const retake = controls.createEl("button", { text: "Retake" });
    retake.addEventListener("click", () => {
      this.clearCurrentImage();
      this.renderCaptureState();
      this.openCameraCapture();
    }, { signal: this.abort.signal });
    const add = controls.createEl("button", { text: "Add another page" });
    add.addEventListener("click", () => void this.addCurrentPage(), { signal: this.abort.signal });
    const confirm = controls.createEl("button", { text: "Confirm", cls: "mod-cta" });
    confirm.addEventListener("click", () => void this.confirm(), { signal: this.abort.signal });
    const cancel = controls.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.cancel(), { signal: this.abort.signal });
  }

  private moveCorner(event: PointerEvent): void {
    const preview = this.preview;
    const corner = this.draggingCorner;
    if (!preview || !corner) return;
    const rect = preview.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const point: ScanPoint = {
      x: clamp((event.clientX - rect.left) / rect.width, 0.01, 0.99),
      y: clamp((event.clientY - rect.top) / rect.height, 0.01, 0.99)
    };
    this.currentQuad = { ...this.currentQuad, [corner]: point };
    this.positionCorners();
  }

  private positionCorners(): void {
    const preview = this.preview;
    if (!preview) return;
    for (const corner of CORNERS) {
      const handle = preview.querySelector<HTMLElement>(`[data-corner="${corner}"]`);
      const point = this.currentQuad[corner];
      if (handle) {
        handle.style.left = `${point.x * 100}%`;
        handle.style.top = `${point.y * 100}%`;
      }
    }
  }

  private async processCurrentPage(): Promise<ScanDocumentPage> {
    if (!this.currentImage) throw new Error("Capture a document page first.");
    const canvas = renderPerspectiveCrop(this.currentImage, this.currentQuad, this.currentRotation, this.ownerDocument);
    return canvasToScanPage(canvas);
  }

  private async addCurrentPage(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.completedPages.push(await this.processCurrentPage());
      this.clearCurrentImage();
      this.renderCaptureState();
    } catch (error) {
      this.showCaptureMessage(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
    }
  }

  private async confirm(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const page = await this.processCurrentPage();
      this.settled = true;
      this.resolveResult([...this.completedPages, page]);
      this.close();
    } catch (error) {
      this.showCaptureMessage(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
    }
  }

  private cancel(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveResult(null);
    this.close();
  }

  private clearCurrentImage(): void {
    if (this.currentObjectUrl) {
      const urlApi = this.ownerDocument.defaultView?.URL ?? URL;
      urlApi.revokeObjectURL(this.currentObjectUrl);
    }
    this.currentObjectUrl = null;
    this.currentImage?.remove();
    this.currentImage = null;
    this.draggingCorner = null;
  }
}
