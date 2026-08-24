import { describe, expect, it, vi } from "vitest";
import type { PdfTextAnnotation } from "../src/model";
import { TextAnnotationSession } from "../src/text/TextAnnotationSession";
import { AddTextAnnotationCommand, DeleteTextAnnotationsCommand, ReplaceTextAnnotationCommand } from "../src/text/TextAnnotationCommands";
import { CommandHistory } from "../src/history/CommandHistory";

const annotation1: PdfTextAnnotation = {
  id: "id1",
  page: 1,
  text: "Hello",
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  color: "#000",
  fontSize: 12,
  fontFamily: "Arial",
  bold: false,
  italic: false,
  strikethrough: false,
  runs: [],
  sourceRuns: [],
  createdAt: "now",
  updatedAt: "now"
};

const annotation2: PdfTextAnnotation = {
  id: "id2",
  page: 1,
  text: "World",
  x: 50,
  y: 60,
  width: 100,
  height: 50,
  color: "#000",
  fontSize: 12,
  fontFamily: "Arial",
  bold: false,
  italic: false,
  strikethrough: false,
  runs: [],
  sourceRuns: [],
  createdAt: "now",
  updatedAt: "now"
};

describe("TextAnnotationCommands", () => {
  it("undoes and redoes DeleteTextAnnotationsCommand", () => {
    const changed = vi.fn();
    const session = new TextAnnotationSession([annotation1, annotation2]);
    const history = new CommandHistory(changed);

    expect(session.all()).toHaveLength(2);

    history.execute(new DeleteTextAnnotationsCommand(session, [annotation1]));
    expect(session.all()).toHaveLength(1);
    expect(session.all()[0]?.id).toBe("id2");

    history.undo();
    expect(session.all()).toHaveLength(2);

    history.redo();
    expect(session.all()).toHaveLength(1);
    expect(session.all()[0]?.id).toBe("id2");

    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("undoes and redoes AddTextAnnotationCommand", () => {
    const changed = vi.fn();
    const session = new TextAnnotationSession();
    const history = new CommandHistory(changed);

    expect(session.all()).toHaveLength(0);

    history.execute(new AddTextAnnotationCommand(session, annotation1));
    expect(session.all()).toHaveLength(1);
    expect(session.all()[0]?.id).toBe("id1");

    history.undo();
    expect(session.all()).toHaveLength(0);

    history.redo();
    expect(session.all()).toHaveLength(1);
    expect(session.all()[0]?.id).toBe("id1");

    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("undoes and redoes ReplaceTextAnnotationCommand", () => {
    const changed = vi.fn();
    const session = new TextAnnotationSession([annotation1]);
    const history = new CommandHistory(changed);

    const afterAnnotation = { ...annotation1, text: "Replaced" };

    expect(session.all()).toHaveLength(1);
    expect(session.all()[0]?.text).toBe("Hello");

    history.execute(new ReplaceTextAnnotationCommand(session, annotation1, afterAnnotation));
    expect(session.all()).toHaveLength(1);
    expect(session.all()[0]?.text).toBe("Replaced");

    history.undo();
    expect(session.all()).toHaveLength(1);
    expect(session.all()[0]?.text).toBe("Hello");

    history.redo();
    expect(session.all()).toHaveLength(1);
    expect(session.all()[0]?.text).toBe("Replaced");

    expect(changed).toHaveBeenCalledTimes(3);
  });
});
