import { describe, expect, it } from "vitest";
import {
  AddTextAnnotationCommand,
  DeleteTextAnnotationsCommand,
  ReplaceTextAnnotationCommand
} from "../src/text/TextAnnotationCommands";
import { TextAnnotationSession } from "../src/text/TextAnnotationSession";
import { PdfTextAnnotation } from "../src/model";

describe("TextAnnotationCommands", () => {
  const dummyAnnotation: PdfTextAnnotation = {
    id: "a1",
    page: 1,
    text: "hello",
    x: 10,
    y: 20,
    width: 100,
    height: 20,
    color: "#000",
    fontSize: 12,
    fontFamily: "Arial"
  };

  const dummyAnnotation2: PdfTextAnnotation = {
    id: "a2",
    page: 1,
    text: "world",
    x: 10,
    y: 50,
    width: 100,
    height: 20,
    color: "#000",
    fontSize: 12,
    fontFamily: "Arial"
  };

  describe("AddTextAnnotationCommand", () => {
    it("adds an annotation to the session when executed", () => {
      const session = new TextAnnotationSession();
      const command = new AddTextAnnotationCommand(session, dummyAnnotation);

      command.execute();
      expect(session.page(1)).toEqual([dummyAnnotation]);
    });

    it("removes the annotation from the session when undone", () => {
      const session = new TextAnnotationSession();
      const command = new AddTextAnnotationCommand(session, dummyAnnotation);

      command.execute();
      command.undo();
      expect(session.page(1)).toEqual([]);
    });
  });

  describe("DeleteTextAnnotationsCommand", () => {
    it("removes annotations from the session when executed", () => {
      const session = new TextAnnotationSession([dummyAnnotation, dummyAnnotation2]);
      const command = new DeleteTextAnnotationsCommand(session, [dummyAnnotation, dummyAnnotation2]);

      command.execute();
      expect(session.page(1)).toEqual([]);
    });

    it("restores the annotations to the session when undone", () => {
      const session = new TextAnnotationSession([dummyAnnotation, dummyAnnotation2]);
      const command = new DeleteTextAnnotationsCommand(session, [dummyAnnotation]);

      command.execute();
      command.undo();

      const annotations = session.page(1);
      expect(annotations).toHaveLength(2);
      expect(annotations).toContainEqual(dummyAnnotation);
      expect(annotations).toContainEqual(dummyAnnotation2);
    });
  });

  describe("ReplaceTextAnnotationCommand", () => {
    it("replaces the old annotation with the new one when executed", () => {
      const session = new TextAnnotationSession([dummyAnnotation]);

      const updatedAnnotation = { ...dummyAnnotation, text: "updated" };
      const command = new ReplaceTextAnnotationCommand(session, dummyAnnotation, updatedAnnotation);

      command.execute();
      expect(session.page(1)).toEqual([updatedAnnotation]);
    });

    it("restores the old annotation when undone", () => {
      const session = new TextAnnotationSession([dummyAnnotation]);

      const updatedAnnotation = { ...dummyAnnotation, text: "updated" };
      const command = new ReplaceTextAnnotationCommand(session, dummyAnnotation, updatedAnnotation);

      command.execute();
      command.undo();
      expect(session.page(1)).toEqual([dummyAnnotation]);
    });
  });
});
