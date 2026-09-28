import { FuzzySuggestModal, Modal, type App, type FuzzyMatch, type TFile } from "obsidian";
import { parsePageRanges } from "../util/parsePageRanges";

export function parsePdfPageSelection(input: string, pageCount: number): number[] | null {
  if (!Number.isInteger(pageCount) || pageCount < 1) return null;
  if (input.trim().toLowerCase() === "all") return Array.from({ length: pageCount }, (_, index) => index + 1);
  return parsePageRanges(input, pageCount);
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
