import { describe, expect, it, vi } from "vitest";
import { PdfImportFilePicker, PdfPageSelectionModal, parsePdfPageSelection } from "../src/ui/PdfPageImport";

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

  it("lists PDFs including the open destination and reports picker cancellation", () => {
    const first = { path: "source.pdf", extension: "pdf" };
    const destination = { path: "destination.pdf", extension: "pdf" };
    const cancelled = vi.fn();
    const picker = new PdfImportFilePicker(
      { vault: { getFiles: () => [first, destination, { path: "note.md", extension: "md" }] } } as never,
      destination.path,
      vi.fn(),
      cancelled
    );
    expect(picker.getItems()).toEqual([first, destination]);
    picker.open();
    picker.close();
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
