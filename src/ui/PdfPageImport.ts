import { FuzzySuggestModal, Modal, type App, type FuzzyMatch, type TFile } from "obsidian";
import { parsePageRanges } from "../util/parsePageRanges";

export function parsePdfPageSelection(input: string, pageCount: number): number[] | null {
  if (!Number.isInteger(pageCount) || pageCount < 1) return null;
  if (input.trim().toLowerCase() === "all") return Array.from({ length: pageCount }, (_, index) => index + 1);
  return parsePageRanges(input, pageCount);
}

export type PdfImportLocation = "after-current" | "before-current" | "start" | "end" | "after-page";

export interface PdfImportOptions {
  /** One-indexed source-PDF pages to copy, in document order. */
  readonly pageNumbers: number[];
  /** Insert after this destination page; zero inserts at the beginning. */
  readonly afterPage: number;
}

export interface PdfImportOptionsModalConfig {
  readonly sourcePageCount: number;
  readonly destinationPageCount: number;
  readonly currentPage: number;
  readonly sourceName?: string;
  readonly destinationName?: string;
}

/**
 * Second step of Import page: choose the source pages and destination position.
 * Keeping this in one modal makes the destructive source-PDF write explicit and
 * prevents an accidental all-pages import at the wrong location.
 */
export class PdfImportOptionsModal extends Modal {
  private readonly abort = new AbortController();
  private readonly currentPage: number;
  private readonly config: PdfImportOptionsModalConfig;
  private pageModeEl: HTMLInputElement | null = null;
  private pageRangeEl: HTMLInputElement | null = null;
  private locationEl: HTMLSelectElement | null = null;
  private afterPageEl: HTMLInputElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;
  private completed = false;

  constructor(
    app: App,
    config: PdfImportOptionsModalConfig,
    private readonly onChoose: (options: PdfImportOptions) => void,
    private readonly onCancel: () => void
  ) {
    super(app);
    this.config = config;
    this.currentPage = Math.min(
      Math.max(1, Math.trunc(config.currentPage)),
      Math.max(1, config.destinationPageCount)
    );
  }

  onOpen(): void {
    const source = this.config.sourceName ? ` from ${this.config.sourceName}` : "";
    const destination = this.config.destinationName ? ` into ${this.config.destinationName}` : "";
    this.titleEl.setText("Import pages");
    this.contentEl.createEl("p", {
      text: `Choose what to import${source} and where to place it${destination}.`
    });

    const pagesHeading = this.contentEl.createEl("h4", { text: "Pages to import" });
    pagesHeading.setAttribute("id", "native-pdf-handwriting-import-pages-heading");
    const pageOptions = this.contentEl.createDiv({ cls: "native-pdf-handwriting-import-options" });
    this.pageModeEl = pageOptions.createEl("input", { type: "radio" });
    this.pageModeEl.name = "native-pdf-handwriting-import-page-mode";
    this.pageModeEl.value = "all";
    this.pageModeEl.checked = true;
    this.pageModeEl.id = "native-pdf-handwriting-import-all-pages";
    const allLabel = pageOptions.createEl("label", { text: `All pages (${this.config.sourcePageCount})` });
    allLabel.prepend(this.pageModeEl);

    const specificMode = pageOptions.createEl("input", { type: "radio" });
    specificMode.name = "native-pdf-handwriting-import-page-mode";
    specificMode.value = "specific";
    specificMode.id = "native-pdf-handwriting-import-specific-pages";
    const specificLabel = pageOptions.createEl("label", { text: "Specific pages or ranges" });
    specificLabel.prepend(specificMode);

    this.pageRangeEl = this.contentEl.createEl("input", {
      type: "text",
      placeholder: "1, 3-5",
      cls: "native-pdf-handwriting-page-range-input"
    });
    this.pageRangeEl.setAttribute("aria-label", "Specific pages or ranges to import");
    this.pageRangeEl.setAttribute("aria-describedby", pagesHeading.id);
    this.pageRangeEl.disabled = true;

    this.contentEl.createEl("h4", { text: "Import location" });
    const location = this.contentEl.createDiv({ cls: "native-pdf-handwriting-import-options" });
    this.locationEl = location.createEl("select", { cls: "native-pdf-handwriting-import-location" });
    this.locationEl.setAttribute("aria-label", "Where to import pages");
    this.addLocationOption("after-current", `After current page (page ${this.currentPage})`);
    this.addLocationOption("before-current", `Before current page (page ${this.currentPage})`);
    this.addLocationOption("start", "At beginning of document");
    this.addLocationOption("end", "At end of document");
    this.addLocationOption("after-page", "After a specific page…");
    this.afterPageEl = location.createEl("input", {
      type: "number",
      value: String(this.currentPage),
      cls: "native-pdf-handwriting-import-after-page"
    });
    this.afterPageEl.setAttribute("aria-label", "Destination page to insert after");
    this.afterPageEl.min = "1";
    this.afterPageEl.max = String(this.config.destinationPageCount);
    this.afterPageEl.disabled = true;

    this.summaryEl = this.contentEl.createEl("p", {
      cls: "native-pdf-handwriting-import-count"
    });
    this.errorEl = this.contentEl.createEl("p", { cls: "native-pdf-handwriting-import-error" });
    const actions = this.contentEl.createDiv({ cls: "native-pdf-handwriting-confirm-actions" });
    const importButton = actions.createEl("button", { text: "Import pages", cls: "mod-cta" });
    const cancel = actions.createEl("button", { text: "Cancel" });

    this.pageRangeEl.addEventListener("input", () => this.refreshSummary(), { signal: this.abort.signal });
    this.pageRangeEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.submit();
      }
    }, { signal: this.abort.signal });
    this.pageModeEl.addEventListener("change", () => this.updatePageMode(), { signal: this.abort.signal });
    specificMode.addEventListener("change", () => this.updatePageMode(), { signal: this.abort.signal });
    this.locationEl.addEventListener("change", () => this.updateLocationMode(), { signal: this.abort.signal });
    this.afterPageEl.addEventListener("input", () => this.refreshSummary(), { signal: this.abort.signal });
    importButton.addEventListener("click", () => this.submit(), { signal: this.abort.signal });
    cancel.addEventListener("click", () => this.close(), { signal: this.abort.signal });
    this.updatePageMode();
    this.updateLocationMode();
    this.refreshSummary();
  }

  onClose(): void {
    this.abort.abort();
    this.contentEl.replaceChildren();
    this.pageModeEl = null;
    this.pageRangeEl = null;
    this.locationEl = null;
    this.afterPageEl = null;
    this.summaryEl = null;
    this.errorEl = null;
    if (!this.completed) this.onCancel();
  }

  private addLocationOption(value: PdfImportLocation, text: string): void {
    this.locationEl?.createEl("option", { value, text });
  }

  private updatePageMode(): void {
    const specific = this.pageModeEl?.checked !== true;
    if (this.pageRangeEl) this.pageRangeEl.disabled = !specific;
    this.refreshSummary();
  }

  private updateLocationMode(): void {
    const custom = this.locationEl?.value === "after-page";
    if (this.afterPageEl) this.afterPageEl.disabled = !custom;
    this.refreshSummary();
  }

  private selectedPages(): number[] | null {
    if (this.pageModeEl?.checked) {
      return Array.from({ length: this.config.sourcePageCount }, (_, index) => index + 1);
    }
    return parsePdfPageSelection(this.pageRangeEl?.value ?? "", this.config.sourcePageCount);
  }

  private destinationAfterPage(): number | null {
    switch (this.locationEl?.value as PdfImportLocation | undefined) {
      case "before-current": return this.currentPage - 1;
      case "start": return 0;
      case "end": return this.config.destinationPageCount;
      case "after-page": {
        const page = Number(this.afterPageEl?.value ?? "");
        return Number.isInteger(page) && page >= 1 && page <= this.config.destinationPageCount ? page : null;
      }
      case "after-current":
      default: return this.currentPage;
    }
  }

  private refreshSummary(): void {
    if (!this.summaryEl) return;
    const count = this.selectedPages()?.length ?? 0;
    const location = this.locationEl?.selectedOptions[0]?.textContent?.replace("…", "") ?? "the selected location";
    this.summaryEl.textContent = `${count} page${count === 1 ? "" : "s"} will be imported ${location.toLowerCase()}.`;
  }

  private submit(): void {
    const pageNumbers = this.selectedPages();
    const afterPage = this.destinationAfterPage();
    if (!pageNumbers?.length) {
      if (this.errorEl) this.errorEl.textContent = "Choose all pages or enter valid page numbers and ranges.";
      return;
    }
    if (afterPage === null) {
      if (this.errorEl) this.errorEl.textContent = `Choose a destination page from 1-${this.config.destinationPageCount}.`;
      return;
    }
    this.completed = true;
    this.onChoose({ pageNumbers, afterPage });
    this.close();
  }
}

export class PdfPageSelectionModal extends Modal {
  private readonly abort = new AbortController();
  private inputEl: HTMLInputElement | null = null;
  private countEl: HTMLElement | null = null;
  private completed = false;

  constructor(
    app: App,
    private readonly pageCount: number,
    private readonly onChoose: (pageNumbers: number[]) => void,
    private readonly onCancel: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Import pages");
    this.contentEl.createEl("p", { text: `Choose pages from this PDF (1-${this.pageCount}).` });
    this.inputEl = this.contentEl.createEl("input", {
      type: "text",
      placeholder: "1, 3-5 or all",
      cls: "native-pdf-handwriting-page-range-input"
    });
    this.inputEl.setAttribute("aria-label", "Pages to import");
    this.countEl = this.contentEl.createEl("p", {
      cls: "native-pdf-handwriting-import-count",
      text: "0 Pages will be imported."
    });
    const error = this.contentEl.createEl("p", { cls: "native-pdf-handwriting-import-error" });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.submit();
      }
    }, { signal: this.abort.signal });
    this.inputEl.addEventListener("input", () => {
      error.textContent = "";
      this.refreshCount();
    }, { signal: this.abort.signal });
    const actions = this.contentEl.createDiv({ cls: "native-pdf-handwriting-confirm-actions" });
    const all = actions.createEl("button", { text: "All pages" });
    all.addEventListener("click", () => {
      if (this.inputEl) this.inputEl.value = "all";
      this.refreshCount();
      this.submit(Array.from({ length: this.pageCount }, (_, index) => index + 1));
    }, { signal: this.abort.signal });
    const importButton = actions.createEl("button", { text: "Import", cls: "mod-cta" });
    importButton.addEventListener("click", () => this.submit(), { signal: this.abort.signal });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close(), { signal: this.abort.signal });
    this.inputEl.focus();

    this.inputEl.addEventListener("input", () => { error.textContent = ""; }, { signal: this.abort.signal });
  }

  onClose(): void {
    this.abort.abort();
    this.contentEl.replaceChildren();
    this.inputEl = null;
    this.countEl = null;
    if (!this.completed) this.onCancel();
  }

  private refreshCount(): void {
    if (!this.countEl) return;
    const selected = parsePdfPageSelection(this.inputEl?.value ?? "", this.pageCount);
    const count = selected?.length ?? 0;
    this.countEl.textContent = `${count} page${count === 1 ? "" : "s"} will be imported.`;
  }

  private submit(pageNumbers?: number[]): void {
    const selected = pageNumbers ?? parsePdfPageSelection(this.inputEl?.value ?? "", this.pageCount);
    if (!selected?.length) {
      const error = this.contentEl.querySelector<HTMLElement>(".native-pdf-handwriting-import-error");
      if (error) error.textContent = "Enter valid page numbers, ranges, or all.";
      return;
    }
    this.completed = true;
    this.onChoose(selected);
    this.close();
  }
}

export interface ExternalPdfImport {
  readonly kind: "external";
  readonly name: string;
  readonly bytes: Uint8Array;
}

export type PdfImportSource = TFile | ExternalPdfImport;

interface ExternalPdfImportAction {
  readonly kind: "external-action";
  readonly label: string;
}

const EXTERNAL_IMPORT_ACTION: ExternalPdfImportAction = {
  kind: "external-action",
  label: "Import from device…"
};

type PdfImportItem = TFile | ExternalPdfImportAction;

function isExternalImportAction(item: PdfImportItem): item is ExternalPdfImportAction {
  return "kind" in item && item.kind === "external-action";
}

export function isExternalPdfImport(source: PdfImportSource): source is ExternalPdfImport {
  return "bytes" in source;
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  const header = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  const limit = Math.min(bytes.length - header.length + 1, 1024);
  for (let offset = 0; offset < limit; offset += 1) {
    if (header.every((value, index) => bytes[offset + index] === value)) return true;
  }
  return false;
}

/** Read and minimally validate a device-selected PDF before handing it to import. */
export async function readExternalPdf(file: Pick<File, "name" | "type" | "arrayBuffer">): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error("The selected PDF could not be read.");
  }
  if (!bytes.length) throw new Error("The selected PDF is empty.");
  const namedPdf = file.name.trim().toLowerCase().endsWith(".pdf");
  const typedPdf = file.type.trim().toLowerCase() === "application/pdf";
  if (!namedPdf && !typedPdf && !hasPdfHeader(bytes)) throw new Error("Select a PDF file.");
  if (!hasPdfHeader(bytes)) throw new Error("The selected file is not a valid PDF.");
  return bytes;
}

/** Vault PDF picker. Destination may be selected for safe self-import. */
export class PdfImportFilePicker extends FuzzySuggestModal<PdfImportItem> {
  private chosen = false;
  private externalInput: HTMLInputElement | null = null;
  private externalSettled = false;

  constructor(
    app: App,
    private readonly excludedPath: string,
    private readonly onChoose: (source: PdfImportSource) => void,
    private readonly onCancel: () => void,
    private readonly onError?: (message: string) => void
  ) {
    super(app);
    this.setPlaceholder("Choose a PDF to import");
  }

  getItems(): PdfImportItem[] {
    const includeOpenFile = this.excludedPath.length >= 0;
    return [
      ...this.app.vault.getFiles().filter((file) =>
        includeOpenFile && file.extension.toLowerCase() === "pdf"
      ),
      EXTERNAL_IMPORT_ACTION
    ];
  }

  /** Keep the external action at the bottom even when fuzzy filtering removes every vault file. */
  getSuggestions(query: string): FuzzyMatch<PdfImportItem>[] {
    const suggestions = super.getSuggestions(query).filter(({ item }) => !isExternalImportAction(item));
    return [...suggestions, { item: EXTERNAL_IMPORT_ACTION, match: { score: 0, matches: [] } }];
  }

  getItemText(item: PdfImportItem): string {
    return isExternalImportAction(item) ? item.label : item.path;
  }

  onChooseItem(item: PdfImportItem): void {
    this.chosen = true;
    if (isExternalImportAction(item)) {
      this.openExternalPicker();
      this.close();
      return;
    }
    this.onChoose(item);
  }

  onClose(): void {
    super.onClose();
    if (!this.chosen) this.onCancel();
  }

  private openExternalPicker(): void {
    if (this.externalInput) return;
    const ownerDocument = this.contentEl.ownerDocument ?? document;
    const input = ownerDocument.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.hidden = true;
    input.addEventListener("change", () => {
      void this.handleExternalFile(input.files?.[0] ?? null);
    });
    input.addEventListener("cancel", () => this.finishExternalCancel());
    ownerDocument.body?.append(input);
    this.externalInput = input;
    input.click();
  }

  private async handleExternalFile(file: File | null): Promise<void> {
    if (!file || this.externalSettled) {
      if (!file) this.finishExternalCancel();
      return;
    }
    try {
      const bytes = await readExternalPdf(file);
      this.finishExternalChoose({ kind: "external", name: file.name, bytes });
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : "The selected PDF could not be read.");
      this.finishExternalCancel();
    }
  }

  private finishExternalChoose(source: ExternalPdfImport): void {
    if (this.externalSettled) return;
    this.externalSettled = true;
    this.removeExternalInput();
    this.onChoose(source);
  }

  private finishExternalCancel(): void {
    if (this.externalSettled) return;
    this.externalSettled = true;
    this.removeExternalInput();
    this.onCancel();
  }

  private removeExternalInput(): void {
    this.externalInput?.remove();
    this.externalInput = null;
  }
}
