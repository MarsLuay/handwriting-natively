import type { PdfTextAnnotation } from "../model";
import type { Command } from "../history/CommandHistory";
import type { TextAnnotationSession } from "./TextAnnotationSession";

export class AddTextAnnotationCommand implements Command {
  readonly label = "Add text annotation";
  constructor(private readonly session: TextAnnotationSession, private readonly annotation: PdfTextAnnotation) {}
  execute(): void { this.session.add(this.annotation); }
  undo(): void { this.session.remove(this.annotation.id); }
}

export class DeleteTextAnnotationsCommand implements Command {
  readonly label = "Delete text annotations";
  constructor(private readonly session: TextAnnotationSession, private readonly annotations: readonly PdfTextAnnotation[]) {}
  execute(): void { this.annotations.forEach((annotation) => this.session.remove(annotation.id)); }
  undo(): void { this.annotations.forEach((annotation) => this.session.add(annotation)); }
}

export class ReplaceTextAnnotationCommand implements Command {
  readonly label = "Edit text annotation";
  constructor(
    private readonly session: TextAnnotationSession,
    private readonly before: PdfTextAnnotation,
    private readonly after: PdfTextAnnotation
  ) {}
  execute(): void { this.session.replace(this.after); }
  undo(): void { this.session.replace(this.before); }
}
