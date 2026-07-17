import type { InkStroke, PdfTextAnnotation } from "../model";
import type { InkSession } from "../ink/InkSession";
import type { TextAnnotationSession } from "../text/TextAnnotationSession";
import type { Command } from "./CommandHistory";

export class AddStrokeCommand implements Command {
  readonly label = "Add stroke";
  constructor(private readonly session: InkSession, private readonly stroke: InkStroke) {}
  execute(): void { this.session.add(this.stroke); }
  undo(): void { this.session.remove(this.stroke.id); }
}

export class AddStrokesCommand implements Command {
  readonly label = "Add strokes";
  private readonly strokes: InkStroke[];
  constructor(private readonly session: InkSession, strokes: readonly InkStroke[]) { this.strokes = [...strokes]; }
  execute(): void { this.strokes.forEach((stroke) => this.session.add(stroke)); }
  undo(): void { this.strokes.forEach((stroke) => this.session.remove(stroke.id)); }
}

export class DeleteStrokesCommand implements Command {
  readonly label = "Delete strokes";
  private readonly strokes: InkStroke[];
  constructor(private readonly session: InkSession, strokes: readonly InkStroke[]) { this.strokes = [...strokes]; }
  execute(): void { this.strokes.forEach((stroke) => this.session.remove(stroke.id)); }
  undo(): void { this.strokes.forEach((stroke) => this.session.add(stroke)); }
}

export class ReplacePageStrokesCommand implements Command {
  readonly label = "Erase stroke segments";
  private readonly before: readonly InkStroke[];
  private readonly after: readonly InkStroke[];

  constructor(private readonly session: InkSession, private readonly page: number, before: readonly InkStroke[], after: readonly InkStroke[]) {
    this.before = [...before];
    this.after = [...after];
  }

  execute(): void { this.session.replacePage(this.page, this.after); }
  undo(): void { this.session.replacePage(this.page, this.before); }
}

export class ReplaceStrokesCommand implements Command {
  readonly label = "Transform strokes";
  constructor(private readonly session: InkSession, private readonly before: readonly InkStroke[], private readonly after: readonly InkStroke[]) {
    if (before.length !== after.length) throw new Error("Replacement sets must have equal length");
  }
  execute(): void { this.after.forEach((stroke) => this.session.replace(stroke)); }
  undo(): void { this.before.forEach((stroke) => this.session.replace(stroke)); }
}

/** Move an ink/text selection as one history operation. */
export class ReplaceAnnotationSelectionCommand implements Command {
  readonly label = "Move annotations";

  constructor(
    private readonly ink: InkSession,
    private readonly beforeStrokes: readonly InkStroke[],
    private readonly afterStrokes: readonly InkStroke[],
    private readonly texts: TextAnnotationSession,
    private readonly beforeTexts: readonly PdfTextAnnotation[],
    private readonly afterTexts: readonly PdfTextAnnotation[]
  ) {
    if (beforeStrokes.length !== afterStrokes.length || beforeTexts.length !== afterTexts.length) {
      throw new Error("Replacement sets must have equal lengths");
    }
  }

  execute(): void {
    this.afterStrokes.forEach((stroke) => this.ink.replace(stroke));
    this.afterTexts.forEach((text) => this.texts.replace(text));
  }

  undo(): void {
    this.beforeStrokes.forEach((stroke) => this.ink.replace(stroke));
    this.beforeTexts.forEach((text) => this.texts.replace(text));
  }
}

export function translateStrokes(strokes: readonly InkStroke[], dx: number, dy: number, now = new Date().toISOString()): InkStroke[] {
  return strokes.map((stroke) => ({ ...stroke, updatedAt: now, points: stroke.points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy })) }));
}
