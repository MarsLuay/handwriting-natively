import { describe, expect, it, vi } from "vitest";
import type { InkStroke } from "../src/model";
import { InkSession } from "../src/ink/InkSession";
import { AddStrokeCommand, DeleteStrokesCommand, ReplacePageStrokesCommand, ReplaceStrokesCommand, ReplaceAnnotationSelectionCommand, translateStrokes } from "../src/history/AnnotationCommands";
import { CommandHistory } from "../src/history/CommandHistory";
import { TextAnnotationSession } from "../src/text/TextAnnotationSession";
import type { PdfTextAnnotation } from "../src/model";

const stroke: InkStroke = { id: "s", page: 1, tool: "pen", color: "#000000", width: 2, opacity: 1, inputType: "pen", points: [{ x: 1, y: 2, pressure: 1, time: 0 }], createdAt: "now", updatedAt: "now" };

describe("annotation command history", () => {
  it("undoes and redoes add, delete, and transform commands", () => {
    const changed = vi.fn(); const session = new InkSession(); const history = new CommandHistory(changed);
    history.execute(new AddStrokeCommand(session, stroke));
    expect(session.all()).toHaveLength(1);
    history.undo(); expect(session.all()).toHaveLength(0);
    history.redo(); expect(session.all()).toHaveLength(1);
    const moved = translateStrokes([stroke], 3, 4, "later");
    history.execute(new ReplaceStrokesCommand(session, [stroke], moved));
    expect(session.all()[0]?.points[0]).toMatchObject({ x: 4, y: 6 });
    history.undo(); expect(session.all()[0]?.points[0]).toMatchObject({ x: 1, y: 2 });
    history.execute(new DeleteStrokesCommand(session, [stroke]));
    expect(session.all()).toHaveLength(0); history.undo(); expect(session.all()).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(7);
  });

  it("replaces one erased stroke with any number of surviving segments", () => {
    const session = new InkSession([stroke]);
    const history = new CommandHistory(() => undefined);
    const left = { ...stroke, id: "left", points: [{ ...stroke.points[0]!, x: 0 }] };
    const right = { ...stroke, id: "right", points: [{ ...stroke.points[0]!, x: 4 }] };

    history.execute(new ReplacePageStrokesCommand(session, 1, [stroke], [left, right]));
    expect(session.all().map((item) => item.id)).toEqual(["left", "right"]);

    history.undo();
    expect(session.all().map((item) => item.id)).toEqual(["s"]);

    history.redo();
    expect(session.all().map((item) => item.id)).toEqual(["left", "right"]);
  });

  it("throws an error when initializing replace commands with unequal array lengths", () => {
    const session = new InkSession();
    const texts = new TextAnnotationSession();
    const text = { id: "t", page: 1, text: "hello", x: 0, y: 0, width: 10, height: 10, color: "#000000", fontSize: 12, fontFamily: "sans-serif" } as PdfTextAnnotation;

    expect(() => new ReplaceStrokesCommand(session, [stroke], [])).toThrowError("Replacement sets must have equal length");
    expect(() => new ReplaceStrokesCommand(session, [], [stroke])).toThrowError("Replacement sets must have equal length");

    expect(() => new ReplaceAnnotationSelectionCommand(session, [stroke], [], texts, [], [])).toThrowError("Replacement sets must have equal lengths");
    expect(() => new ReplaceAnnotationSelectionCommand(session, [], [stroke], texts, [], [])).toThrowError("Replacement sets must have equal lengths");
    expect(() => new ReplaceAnnotationSelectionCommand(session, [], [], texts, [text], [])).toThrowError("Replacement sets must have equal lengths");
    expect(() => new ReplaceAnnotationSelectionCommand(session, [], [], texts, [], [text])).toThrowError("Replacement sets must have equal lengths");
  });
});
