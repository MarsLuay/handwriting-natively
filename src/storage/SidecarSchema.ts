import type { InkStroke, PdfTextAnnotation, PdfTextRun } from "../model";

export const SIDECAR_SCHEMA_VERSION = 1 as const;

export interface SidecarDocumentIdentity {
  id: string;
  vaultPath: string;
  fingerprint?: string;
  contentHash?: string;
}

export interface SidecarPage {
  page: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  strokes: InkStroke[];
  texts?: PdfTextAnnotation[];
}

export interface SidecarSchemaV1 {
  schemaVersion: 1;
  "document": SidecarDocumentIdentity;
  pages: SidecarPage[];
  createdAt: string;
  updatedAt: string;
  extensions?: Record<string, unknown>;
}

export type SidecarSchema = SidecarSchemaV1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isStroke = (value: unknown): value is InkStroke => {
  if (!isRecord(value) || !Array.isArray(value.points)) return false;
  return typeof value.id === "string" && Number.isInteger(value.page) &&
    (value.tool === "pen" || value.tool === "pencil" || value.tool === "highlighter") &&
    typeof value.color === "string" && isFiniteNumber(value.width) && value.width > 0 &&
    isFiniteNumber(value.opacity) && value.opacity >= 0 && value.opacity <= 1 &&
    (value.inputType === "pen" || value.inputType === "mouse" || value.inputType === "touch") &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string" &&
    value.points.every((point) => isRecord(point) && isFiniteNumber(point.x) &&
      isFiniteNumber(point.y) && isFiniteNumber(point.pressure) &&
      isFiniteNumber(point.time));
};

const isTextRun = (value: unknown): value is PdfTextRun => isRecord(value) &&
  typeof value.text === "string" && typeof value.color === "string" &&
  isFiniteNumber(value.fontSize) && value.fontSize > 0 && typeof value.fontFamily === "string" &&
  typeof value.bold === "boolean" && typeof value.italic === "boolean" && typeof value.strikethrough === "boolean";

const isText = (value: unknown): value is PdfTextAnnotation => isRecord(value) &&
  typeof value.id === "string" && Number.isInteger(value.page) && typeof value.text === "string" &&
  isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.width) && value.width > 0 &&
  isFiniteNumber(value.height) && value.height > 0 && typeof value.color === "string" &&
  isFiniteNumber(value.fontSize) && value.fontSize > 0 && typeof value.fontFamily === "string" &&
  typeof value.bold === "boolean" && typeof value.italic === "boolean" && typeof value.strikethrough === "boolean" &&
  Array.isArray(value.runs) && value.runs.every(isTextRun) &&
  Array.isArray(value.sourceRuns) && value.sourceRuns.every(isTextRun) &&
  typeof value.createdAt === "string" && typeof value.updatedAt === "string";

/**
 * PR #15 stored an earlier text shape without box geometry and some newer
 * formatting fields. Normalize only annotations with the required identity and
 * content fields, then keep the normal strict schema validation below.
 */
function normalizeLegacyText(value: unknown): unknown {
  if (!isRecord(value) || typeof value.id !== "string" || !Number.isInteger(value.page) ||
      typeof value.text !== "string" || !isFiniteNumber(value.x) || !isFiniteNumber(value.y) ||
      typeof value.color !== "string" || !isFiniteNumber(value.fontSize) || value.fontSize <= 0 ||
      typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return value;
  const fontFamily = typeof value.fontFamily === "string" ? value.fontFamily : "sans-serif";
  const bold = value.bold === true;
  const italic = value.italic === true;
  const strikethrough = value.strikethrough === true;
  const fallback: PdfTextRun = {
    text: value.text, color: value.color, fontSize: value.fontSize, fontFamily, bold, italic, strikethrough
  };
  const normalizeRun = (run: unknown): PdfTextRun => {
    if (!isRecord(run) || typeof run.text !== "string") return { ...fallback };
    return {
      text: run.text,
      color: typeof run.color === "string" ? run.color : fallback.color,
      fontSize: isFiniteNumber(run.fontSize) && run.fontSize > 0 ? run.fontSize : fallback.fontSize,
      fontFamily: typeof run.fontFamily === "string" ? run.fontFamily : fallback.fontFamily,
      bold: run.bold === true,
      italic: run.italic === true,
      strikethrough: run.strikethrough === true
    };
  };
  const runs = Array.isArray(value.runs) && value.runs.length ? value.runs.map(normalizeRun) : [fallback];
  const sourceRuns = Array.isArray(value.sourceRuns) && value.sourceRuns.length
    ? value.sourceRuns.map(normalizeRun)
    : runs.map((run) => ({ ...run }));
  const longestLine = value.text.split("\n").reduce((longest, line) => Math.max(longest, line.length), 0);
  const lineCount = Math.max(1, value.text.split("\n").length);
  return {
    ...value,
    width: isFiniteNumber(value.width) && value.width > 0 ? value.width : Math.max(24, longestLine * value.fontSize * 0.6),
    height: isFiniteNumber(value.height) && value.height > 0 ? value.height : Math.max(value.fontSize * 1.4, lineCount * value.fontSize * 1.35),
    fontFamily,
    bold,
    italic,
    strikethrough,
    runs,
    sourceRuns
  };
}

function normalizeLegacyTextSidecar(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.pages)) return value;
  const pages: unknown[] = value.pages;
  return {
    ...value,
    pages: pages.map((page) => {
      if (!isRecord(page) || !Array.isArray(page.texts)) return page;
      return { ...page, texts: page.texts.map(normalizeLegacyText) };
    })
  };
}

export function validateSidecar(value: unknown): value is SidecarSchemaV1 {
  if (!isRecord(value) || value.schemaVersion !== SIDECAR_SCHEMA_VERSION ||
      !isRecord(value.document) || !Array.isArray(value.pages)) return false;
  if (typeof value.document.id !== "string" || typeof value.document.vaultPath !== "string" ||
      (value.document.fingerprint !== undefined && typeof value.document.fingerprint !== "string") ||
      (value.document.contentHash !== undefined && typeof value.document.contentHash !== "string") ||
      typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
  return value.pages.every((page) => isRecord(page) && Number.isInteger(page.page) &&
    isFiniteNumber(page.width) && page.width > 0 && isFiniteNumber(page.height) && page.height > 0 &&
    (page.rotation === 0 || page.rotation === 90 || page.rotation === 180 || page.rotation === 270) &&
    Array.isArray(page.strokes) && page.strokes.every(isStroke) &&
    (page.texts === undefined || (Array.isArray(page.texts) && page.texts.every(isText))));
}

export function pickNewerSidecar(
  sidecar: SidecarSchemaV1 | null,
  recovery: SidecarSchemaV1 | null
): SidecarSchemaV1 | null {
  if (!sidecar) return recovery;
  if (!recovery) return sidecar;
  return sidecar.updatedAt >= recovery.updatedAt ? sidecar : recovery;
}

export function countSidecarStrokes(sidecar: SidecarSchemaV1 | null | undefined): number {
  if (!sidecar) return 0;
  return sidecar.pages.reduce((sum, page) => sum + page.strokes.length, 0);
}

export function countSidecarTexts(sidecar: SidecarSchemaV1 | null | undefined): number {
  if (!sidecar) return 0;
  return sidecar.pages.reduce((sum, page) => sum + (page.texts?.length ?? 0), 0);
}

export function serializeSidecar(sidecar: SidecarSchemaV1): string {
  const normalized = normalizeLegacyTextSidecar(sidecar);
  if (!validateSidecar(normalized)) throw new TypeError("Invalid sidecar data");
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export function parseSidecar(json: string): SidecarSchemaV1 {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch {
    throw new TypeError("Sidecar is not valid JSON");
  }
  const normalized = normalizeLegacyTextSidecar(parsed);
  if (!validateSidecar(normalized)) throw new TypeError("Unsupported or invalid sidecar schema");
  return normalized;
}
