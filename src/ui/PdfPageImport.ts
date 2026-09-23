import { FuzzySuggestModal, Modal, type App, type TFile } from "obsidian";
import { parsePageRanges } from "../util/parsePageRanges";

export function parsePdfPageSelection(input: string, pageCount: number): number[] | null {
  if (!Number.isInteger(pageCount) || pageCount < 1) return null;
  if (input.trim().toLowerCase() === "all") return Array.from({ length: pageCount }, (_, index) => index + 1);
  return parsePageRanges(input, pageCount);
}

export class PdfPageSelectionModal extends Modal {
  private readonly abort = new AbortController();
  private inputEl: HTMLInputElement | null = null;
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
    this.inputEl = this.contentEl.createEl("input", { type: "text", placeholder: "1, 3-5 or all" });
    this.inputEl.setAttribute("aria-label", "Pages to import");
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.submit();
      }
    }, { signal: this.abort.signal });
    const error = this.contentEl.createEl("p", { cls: "native-pdf-handwriting-import-error" });
    const actions = this.contentEl.createDiv({ cls: "native-pdf-handwriting-confirm-actions" });
    const all = actions.createEl("button", { text: "All pages" });
    all.addEventListener("click", () => this.submit(Array.from({ length: this.pageCount }, (_, index) => index + 1)), { signal: this.abort.signal });
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
    if (!this.completed) this.onCancel();
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

export class PdfImportFilePicker extends FuzzySuggestModal<TFile> {
  private chosen = false;

  constructor(
    app: App,
    private readonly excludedPath: string,
    private readonly onChoose: (file: TFile) => void,
    private readonly onCancel: () => void
  ) {
    super(app);
    this.setPlaceholder("Choose a PDF to import");
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles()
      .filter((file) => file.extension.toLowerCase() === "pdf" && file.path !== this.excludedPath);
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.chosen = true;
    this.onChoose(file);
  }

  onClose(): void {
    super.onClose();
    if (!this.chosen) this.onCancel();
  }
}
