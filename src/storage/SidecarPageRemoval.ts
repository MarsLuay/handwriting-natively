import type { InkStroke, PdfTextAnnotation } from "../model";
import type { SidecarSchemaV1 } from "./SidecarSchema";

function remapPageNumber(page: number, deletedPage: number): number {
  return page > deletedPage ? page - 1 : page;
}

function remapStroke(stroke: InkStroke, deletedPage: number): InkStroke {
  return stroke.page > deletedPage ? { ...stroke, page: remapPageNumber(stroke.page, deletedPage) } : stroke;
}

function remapText(text: PdfTextAnnotation, deletedPage: number): PdfTextAnnotation {
  return text.page > deletedPage ? { ...text, page: remapPageNumber(text.page, deletedPage) } : text;
}

function shiftPageNumber(page: number, insertedPage: number): number {
  return page >= insertedPage ? page + 1 : page;
}

function shiftStroke(stroke: InkStroke, insertedPage: number): InkStroke {
  return stroke.page >= insertedPage ? { ...stroke, page: shiftPageNumber(stroke.page, insertedPage) } : stroke;
}

function shiftText(text: PdfTextAnnotation, insertedPage: number): PdfTextAnnotation {
  return text.page >= insertedPage ? { ...text, page: shiftPageNumber(text.page, insertedPage) } : text;
}

/** Drops annotations on a deleted PDF page and shifts every later page down one. */
export function removePageFromSidecar(
  sidecar: SidecarSchemaV1,
  deletedPage: number,
  updatedAt = new Date().toISOString()
): SidecarSchemaV1 {
  if (!Number.isInteger(deletedPage) || deletedPage < 1) throw new Error("Deleted page must be a positive integer.");
  return {
    ...sidecar,
    pages: sidecar.pages
      .filter((page) => page.page !== deletedPage)
      .map((page) => ({
        ...page,
        page: remapPageNumber(page.page, deletedPage),
        strokes: page.strokes.map((stroke) => remapStroke(stroke, deletedPage)),
        ...(page.texts ? { texts: page.texts.map((text) => remapText(text, deletedPage)) } : {})
      })),
    updatedAt
  };
}

/** Leaves the inserted page empty while shifting later annotation pages down one. */
export function insertPageIntoSidecar(
  sidecar: SidecarSchemaV1,
  insertedPage: number,
  updatedAt = new Date().toISOString()
): SidecarSchemaV1 {
  if (!Number.isInteger(insertedPage) || insertedPage < 1) throw new Error("Inserted page must be a positive integer.");
  return {
    ...sidecar,
    pages: sidecar.pages.map((page) => ({
      ...page,
      page: shiftPageNumber(page.page, insertedPage),
      strokes: page.strokes.map((stroke) => shiftStroke(stroke, insertedPage)),
      ...(page.texts ? { texts: page.texts.map((text) => shiftText(text, insertedPage)) } : {})
    })),
    updatedAt
  };
}
