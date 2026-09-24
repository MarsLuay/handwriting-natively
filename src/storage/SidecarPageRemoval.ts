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

function shiftPageNumberByCount(page: number, insertedPage: number, count: number): number {
  return page >= insertedPage ? page + count : page;
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
  return insertPagesIntoSidecar(sidecar, insertedPage, 1, updatedAt);
}

/** Leaves all imported pages empty while shifting later annotation pages. */
export function insertPagesIntoSidecar(
  sidecar: SidecarSchemaV1,
  insertedPage: number,
  insertedPageCount: number,
  updatedAt = new Date().toISOString()
): SidecarSchemaV1 {
  if (!Number.isInteger(insertedPage) || insertedPage < 1) throw new Error("Inserted page must be a positive integer.");
  if (!Number.isInteger(insertedPageCount) || insertedPageCount < 1) {
    throw new Error("Inserted page count must be a positive integer.");
  }
  return {
    ...sidecar,
    pages: sidecar.pages.map((page) => ({
      ...page,
      page: shiftPageNumberByCount(page.page, insertedPage, insertedPageCount),
      strokes: page.strokes.map((stroke) => stroke.page >= insertedPage
        ? { ...stroke, page: shiftPageNumberByCount(stroke.page, insertedPage, insertedPageCount) }
        : stroke),
      ...(page.texts ? { texts: page.texts.map((text) => text.page >= insertedPage
        ? { ...text, page: shiftPageNumberByCount(text.page, insertedPage, insertedPageCount) }
        : text) } : {})
    })),
    updatedAt
  };
}
