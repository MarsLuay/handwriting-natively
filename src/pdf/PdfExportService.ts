import { LineCapStyle, PDFDocument, PDFHexString, rgb } from "pdf-lib";
import { DEFAULT_SETTINGS, type InkStroke, type PdfPoint } from "../model";
import { graphiteStampCircles, seedFromId } from "../tools/PencilTool";
import { penSampleWidth, penSegmentWidths } from "../tools/PenTool";

export interface PdfExportPageMetrics {
  page: number;
  width: number;
  height: number;
}

export interface PdfExportInput {
  sourceBytes: Uint8Array;
  mode?: PdfExportMode;
  strokes?: readonly InkStroke[];
  getStrokes?: () => readonly InkStroke[];
  /** Sidecar / session page sizes — may differ from MediaBox PDF points (e.g. CSS px @96dpi). */
  pageMetrics?: readonly PdfExportPageMetrics[];
  flush?: () => Promise<void>;
}

export type PdfExportMode = "flattened" | "editable";

interface MappedInkStroke {
  points: Array<{ x: number; y: number }>;
  width: number;
}

function parseColor(value: string): ReturnType<typeof rgb> {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return rgb(0, 0, 0);
  const hex = match[1]!;
  return rgb(Number.parseInt(hex.slice(0, 2), 16) / 255, Number.parseInt(hex.slice(2, 4), 16) / 255, Number.parseInt(hex.slice(4, 6), 16) / 255);
}

export function annotatedFilename(sourceName: string): string {
  const base = sourceName.replace(/\.pdf$/i, "");
  return `${base || "document"}_export.pdf`;
}

export function editableAnnotatedFilename(sourceName: string): string {
  const base = sourceName.replace(/\.pdf$/i, "");
  return `${base || "document"}_editable.pdf`;
}

/** Map ink page-space → actual PDF MediaBox points when those spaces differ. */
export function mapInkPointToPdfPage(
  point: Pick<PdfPoint, "x" | "y">,
  inkPage: { width: number; height: number },
  pdfPage: { width: number; height: number }
): { x: number; y: number } {
  const sx = inkPage.width > 0 ? pdfPage.width / inkPage.width : 1;
  const sy = inkPage.height > 0 ? pdfPage.height / inkPage.height : 1;
  return { x: point.x * sx, y: point.y * sy };
}

export function mapInkWidthToPdfPage(
  width: number,
  inkPage: { width: number; height: number },
  pdfPage: { width: number; height: number }
): number {
  const sx = inkPage.width > 0 ? pdfPage.width / inkPage.width : 1;
  const sy = inkPage.height > 0 ? pdfPage.height / inkPage.height : 1;
  return width * ((sx + sy) / 2);
}

export class PdfExportService {
  async export(input: PdfExportInput): Promise<Uint8Array> {
    await input.flush?.();
    const strokes = input.getStrokes?.() ?? input.strokes ?? [];
    const sourceSnapshot = input.sourceBytes.slice();
    const pdfDoc = await PDFDocument.load(sourceSnapshot);
    const metricsByPage = new Map(
      (input.pageMetrics ?? []).map((page) => [page.page, page] as const)
    );
    for (const stroke of strokes) {
      const page = pdfDoc.getPages()[stroke.page - 1];
      if (!page) throw new RangeError(`Stroke ${stroke.id} references missing page ${stroke.page}`);
      const color = parseColor(stroke.color);
      const pdfSize = page.getSize();
      const inkPage = metricsByPage.get(stroke.page);
      const sourceSize = inkPage && inkPage.width > 0 && inkPage.height > 0
        ? { width: inkPage.width, height: inkPage.height }
        : pdfSize;
      // Match on-screen canvas width model; scale into MediaBox points.
      const mapPoint = (point: Pick<PdfPoint, "x" | "y">) => mapInkPointToPdfPage(point, sourceSize, pdfSize);
      const strokeWidth = mapInkWidthToPdfPage(stroke.width, sourceSize, pdfSize);

      if (input.mode === "editable") {
        if (stroke.points.length === 0) continue;
        this.addInkAnnotation(pdfDoc, page, stroke, {
          points: stroke.points.map(mapPoint),
          width: this.editableStrokeWidth(stroke, strokeWidth)
        });
        continue;
      }

      if (stroke.tool === "pencil") {
        const pencil = DEFAULT_SETTINGS.toolPreferences.pencil;
        const stamps = graphiteStampCircles(
          stroke.points.map((point) => {
            const mapped = mapPoint(point);
            return {
              x: mapped.x,
              y: mapped.y,
              pressure: point.pressure,
              tiltX: point.tiltX,
              tiltY: point.tiltY
            };
          }),
          {
            color: stroke.color,
            width: strokeWidth,
            opacity: stroke.opacity,
            textureStrength: pencil.textureStrength,
            pressureSensitivity: pencil.pressureSensitivity,
            tiltSensitivity: pencil.tiltSensitivity,
            thinning: pencil.thinning,
            seed: seedFromId(stroke.id)
          }
        );
        for (const stamp of stamps) {
          page.drawCircle({
            x: stamp.x,
            y: stamp.y,
            size: stamp.radius,
            color,
            opacity: stamp.opacity
          });
        }
        continue;
      }

      const pen = stroke.tool === "highlighter"
        ? DEFAULT_SETTINGS.toolPreferences.highlighter
        : DEFAULT_SETTINGS.toolPreferences.pen;
      const penPrefs = {
        ...pen,
        width: strokeWidth,
        opacity: stroke.opacity,
        color: stroke.color
      };
      if (stroke.points.length === 1) {
        const point = mapPoint(stroke.points[0]!);
        page.drawCircle({
          x: point.x,
          y: point.y,
          size: penSampleWidth(penPrefs, stroke.points[0]!) / 2,
          color,
          opacity: stroke.opacity
        });
        continue;
      }
      const mappedPoints = stroke.points.map((point) => {
        const mapped = mapPoint(point);
        return { x: mapped.x, y: mapped.y, pressure: point.pressure };
      });
      for (const segment of penSegmentWidths(mappedPoints, {
        color: stroke.color,
        width: strokeWidth,
        opacity: stroke.opacity,
        pressureSensitivity: pen.pressureSensitivity,
        thinning: pen.thinning
      })) {
        page.drawLine({
          start: { x: segment.start.x, y: segment.start.y },
          end: { x: segment.end.x, y: segment.end.y },
          thickness: segment.thickness,
          color,
          opacity: stroke.opacity,
          lineCap: LineCapStyle.Round
        });
      }
    }
    const exported = await pdfDoc.save();
    await PDFDocument.load(exported);
    if (!input.sourceBytes.every((byte, index) => byte === sourceSnapshot[index])) throw new Error("Source PDF bytes changed during export");
    return exported;
  }

  async validate(bytes: Uint8Array): Promise<void> { await PDFDocument.load(bytes); }

  private editableStrokeWidth(stroke: InkStroke, width: number): number {
    if (stroke.tool === "pencil") return Math.max(0.5, width * 0.75);
    return Math.max(0.5, width);
  }

  private addInkAnnotation(
    pdfDoc: PDFDocument,
    page: ReturnType<PDFDocument["getPages"]>[number],
    stroke: InkStroke,
    mapped: MappedInkStroke
  ): void {
    const points = mapped.points.length === 1
      ? [mapped.points[0]!, { x: mapped.points[0]!.x + 0.01, y: mapped.points[0]!.y + 0.01 }]
      : mapped.points;
    const padding = Math.max(1, mapped.width / 2 + 1);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs) - padding;
    const minY = Math.min(...ys) - padding;
    const maxX = Math.max(...xs) + padding;
    const maxY = Math.max(...ys) + padding;
    const [red, green, blue] = colorComponents(stroke.color);
    const context = pdfDoc.context;
    const opacity = context.register(context.obj({ Type: "ExtGState", CA: stroke.opacity, ca: stroke.opacity }));
    const appearance = context.register(context.flateStream(
      inkAppearanceStream(points, mapped.width, red, green, blue),
      {
        Type: "XObject",
        Subtype: "Form",
        BBox: [minX, minY, maxX, maxY],
        Resources: { ExtGState: { GS0: opacity } }
      }
    ));
    const annotation = context.register(context.obj({
      Type: "Annot",
      Subtype: "Ink",
      Rect: [minX, minY, maxX, maxY],
      InkList: [points.flatMap((point) => [point.x, point.y])],
      C: [red, green, blue],
      CA: stroke.opacity,
      BS: { Type: "Border", W: mapped.width, S: "S" },
      Border: [0, 0, mapped.width],
      F: 4,
      NM: PDFHexString.fromText(`handwriting-natively-${stroke.id}`),
      AP: { N: appearance }
    }));
    page.node.addAnnot(annotation);
  }
}

function colorComponents(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return [0, 0, 0];
  const hex = match[1]!;
  return [
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255
  ];
}

function inkAppearanceStream(
  points: readonly { x: number; y: number }[],
  width: number,
  red: number,
  green: number,
  blue: number
): string {
  const format = (value: number) => Number(value.toFixed(4)).toString();
  const [first, ...rest] = points;
  return [
    "q",
    `${format(red)} ${format(green)} ${format(blue)} RG`,
    "/GS0 gs",
    `${format(width)} w`,
    "1 J",
    "1 j",
    `${format(first!.x)} ${format(first!.y)} m`,
    ...rest.map((point) => `${format(point.x)} ${format(point.y)} l`),
    "S",
    "Q"
  ].join("\n");
}
