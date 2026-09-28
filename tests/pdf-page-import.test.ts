import { describe, expect, it, vi } from "vitest";
import {
  PdfImportFilePicker,
  PdfPageSelectionModal,
  parsePdfPageSelection,
  readExternalPdf
} from "../src/ui/PdfPageImport";

describe("PDF page import selection", () => {
  it("parses deterministic single, range, multi-page, and all selections", () => {
    expect(parsePdfPageSelection("3", 5)).toEqual([3]);
    expect(parsePdfPageSelection("4, 2-3, 4", 5)).toEqual([2, 3, 4]);
    expect(parsePdfPageSelection("all", 3)).toEqual([1, 2, 3]);
    expect(parsePdfPageSelection("2-6", 5)).toBeNull();
  });

  it("leaves selection cancelled without choosing pages", () => {
    const chosen = vi.fn();
    const cancelled = vi.fn();
    const modal = new PdfPageSelectionModal({} as never, 4, chosen, cancelled);
    modal.open();
    modal.close();
    expect(chosen).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("offers all pages and closes as a successful selection", () => {
    const chosen = vi.fn();
    const cancelled = vi.fn();
    const modal = new PdfPageSelectionModal({} as never, 3, chosen, cancelled);
    modal.open();
    modal.contentEl.querySelector<HTMLButtonElement>("button")?.click();
    expect(chosen).toHaveBeenCalledWith([1, 2, 3]);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("keeps the device action at the bottom with no vault matches", () => {
    const picker = new PdfImportFilePicker(
      { vault: { getFiles: () => [] } } as never,
      "destination.pdf",
      vi.fn(),
      vi.fn()
    );
    const items = picker.getItems();
    expect(items).toHaveLength(1);
    expect(picker.getItemText(items[0]!)).toBe("Import from device…");
    expect(picker.getSuggestions("query-with-no-matches")).toHaveLength(1);
    expect(picker.getItemText(picker.getSuggestions("query-with-no-matches")[0]!.item)).toBe("Import from device…");
  });

  it("keeps vault PDFs searchable before the persistent device action", () => {
    const first = { path: "source.pdf", extension: "pdf" };
    const destination = { path: "destination.pdf", extension: "pdf" };
    const picker = new PdfImportFilePicker(
      { vault: { getFiles: () => [first, destination, { path: "note.md", extension: "md" }] } } as never,
      destination.path,
      vi.fn(),
      vi.fn()
    );
    const items = picker.getItems();
    expect(items.slice(0, -1)).toEqual([first, destination]);
    expect(picker.getItemText(items[items.length - 1]!)).toBe("Import from device…");
    expect(picker.getSuggestions("missing-file").map(({ item }) => picker.getItemText(item))).toEqual(["Import from device…"]);
  });

  it("hands selected external PDF bytes to the existing import callback", async () => {
    const chosen = vi.fn();
    const cancelled = vi.fn();
    const picker = new PdfImportFilePicker(
      { vault: { getFiles: () => [] } } as never,
      "destination.pdf",
      chosen,
      cancelled
    );
    picker.open();
    picker.onChooseItem(picker.getItems()[0]!);
    const input = document.querySelector<HTMLInputElement>("input[type='file']");
    expect(input?.accept).toContain("application/pdf");
    const file = new File(["%PDF-1.7\\nexternal"], "outside.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input?.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(chosen).toHaveBeenCalledOnce());
    expect(chosen.mock.calls[0]?.[0]).toMatchObject({ kind: "external", name: "outside.pdf" });
    expect([...((chosen.mock.calls[0]?.[0] as { bytes: Uint8Array }).bytes)]).toEqual([...new TextEncoder().encode("%PDF-1.7\\nexternal")]);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("cancels external selection without choosing or mutating a source", () => {
    const chosen = vi.fn();
    const cancelled = vi.fn();
    const picker = new PdfImportFilePicker(
      { vault: { getFiles: () => [] } } as never,
      "destination.pdf",
      chosen,
      cancelled
    );
    picker.open();
    picker.onChooseItem(picker.getItems()[0]!);
    const input = document.querySelector<HTMLInputElement>("input[type='file']");
    input?.dispatchEvent(new Event("cancel"));
    expect(chosen).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("rejects unreadable or non-PDF external input", async () => {
    const chosen = vi.fn();
    const cancelled = vi.fn();
    const error = vi.fn();
    const picker = new PdfImportFilePicker(
      { vault: { getFiles: () => [] } } as never,
      "destination.pdf",
      chosen,
      cancelled,
      error
    );
    picker.open();
    picker.onChooseItem(picker.getItems()[0]!);
    const input = document.querySelector<HTMLInputElement>("input[type='file']");
    const file = new File(["not a PDF"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input?.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Select a PDF file."));
    expect(chosen).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledOnce();
    await expect(readExternalPdf(file)).rejects.toThrow("Select a PDF file.");
    await expect(readExternalPdf({
      name: "unreadable.pdf",
      type: "application/pdf",
      arrayBuffer: async () => { throw new Error("read failed"); }
    })).rejects.toThrow("The selected PDF could not be read.");
  });

  it("reports picker cancellation for vault selection", () => {
    const cancelled = vi.fn();
    const picker = new PdfImportFilePicker(
      { vault: { getFiles: () => [{ path: "source.pdf", extension: "pdf" }] } } as never,
      "destination.pdf",
      vi.fn(),
      cancelled
    );
    picker.open();
    picker.close();
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
