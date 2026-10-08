import type { InkStroke, TextAnnotation } from "../model";
import type { SidecarPage, SidecarSchemaV1 } from "./SidecarSchema";

function remapPageNumber(page: number, deletedPage: number): number {
  return page > deletedPage ? page - 1 : page;
}

function remapStroke(stroke: InkStroke, deletedPage: number): InkStroke {
  return stroke.page > deletedPage ? { ...stroke, page: remapPageNumber(stroke.page, deletedPage) } : stroke;
}

function remapText(text: TextAnnotation, deletedPage: number): TextAnnotation {
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

export function reorderPageNumber(page: number, fromPage: number, toPage: number): number {
  if (page === fromPage) return toPage;
  if (fromPage < toPage && page > fromPage && page <= toPage) return page - 1;
  if (fromPage > toPage && page >= toPage && page < fromPage) return page + 1;
  return page;
}

/** Remaps page-numbered annotations while moving one existing page in document order. */
export function reorderPageInSidecar(
  sidecar: SidecarSchemaV1,
  fromPage: number,
  toPage: number,
  updatedAt = new Date().toISOString()
): SidecarSchemaV1 {
  if (!Number.isInteger(fromPage) || fromPage < 1 || !Number.isInteger(toPage) || toPage < 1) {
    throw new Error("Reordered pages must be positive integers.");
  }
  if (fromPage === toPage) return sidecar;
  const remap = (page: number): number => reorderPageNumber(page, fromPage, toPage);
  return {
    ...sidecar,
    pages: sidecar.pages.map((page) => ({
      ...page,
      page: remap(page.page),
      strokes: page.strokes.map((stroke) => ({ ...stroke, page: remap(stroke.page) })),
      ...(page.texts ? { texts: page.texts.map((text) => ({ ...text, page: remap(text.page) })) } : {})
    })).sort((left, right) => left.page - right.page),
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

/** Duplicates an annotated page, copying its strokes and texts onto the newly inserted page. */
export function duplicatePageInSidecar(
  sidecar: SidecarSchemaV1,
  pageNumber: number,
  updatedAt = new Date().toISOString()
): SidecarSchemaV1 {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new Error("Duplicated page must be a positive integer.");
  }
  const sourcePage = sidecar.pages.find((p) => p.page === pageNumber);
  const shifted = insertPageIntoSidecar(sidecar, pageNumber + 1, updatedAt);
  if (!sourcePage) return shifted;

  const newPageNumber = pageNumber + 1;
  const cloneSeed = Date.now();
  const clonedStrokes = sourcePage.strokes.map((stroke, index) => ({
    ...stroke,
    id: `${stroke.id}-copy-${cloneSeed}-${index}`,
    page: newPageNumber,
    createdAt: updatedAt,
    updatedAt
  }));
  const clonedTexts = sourcePage.texts
    ? sourcePage.texts.map((text, index) => ({
      ...text,
      id: `${text.id}-copy-${cloneSeed}-${index}`,
      page: newPageNumber,
      createdAt: updatedAt,
      updatedAt
    }))
    : undefined;

  const { pageId: _prevPageId, ...restSource } = sourcePage;
  const duplicatedPage: SidecarPage = {
    ...restSource,
    page: newPageNumber,
    strokes: clonedStrokes,
    ...(clonedTexts ? { texts: clonedTexts } : {})
  };

  return {
    ...shifted,
    pages: [...shifted.pages, duplicatedPage].sort((left, right) => left.page - right.page),
    updatedAt
  };
}
