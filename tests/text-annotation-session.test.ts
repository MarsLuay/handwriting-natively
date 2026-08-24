import { describe, expect, it } from "vitest";
import { TextAnnotationSession } from "../src/text/TextAnnotationSession";
import type { PdfTextAnnotation, PdfTextRun } from "../src/model";

describe("TextAnnotationSession", () => {
  const mockAnnotation1: PdfTextAnnotation = {
    id: "a1",
    page: 1,
    text: "Hello",
    x: 10,
    y: 20,
    width: 100,
    height: 20,
    color: "#000000",
    fontSize: 12,
    fontFamily: "Arial",
    bold: false,
    italic: false,
    strikethrough: false,
    runs: [],
    sourceRuns: [],
    createdAt: "2023-01-01T00:00:00Z",
    updatedAt: "2023-01-01T00:00:00Z",
  };

  const mockAnnotation2: PdfTextAnnotation = {
    ...mockAnnotation1,
    id: "a2",
    page: 2,
    text: "World",
  };

  const mockAnnotation3: PdfTextAnnotation = {
    ...mockAnnotation1,
    id: "a3",
    page: 1,
    text: "Test",
  };

  describe("constructor", () => {
    it("should initialize empty if no annotations provided", () => {
      const session = new TextAnnotationSession();
      expect(session.all()).toEqual([]);
    });

    it("should initialize with provided annotations", () => {
      const session = new TextAnnotationSession([mockAnnotation1, mockAnnotation2]);
      expect(session.all()).toHaveLength(2);
      expect(session.page(1)).toEqual([mockAnnotation1]);
      expect(session.page(2)).toEqual([mockAnnotation2]);
    });
  });

  describe("add", () => {
    it("should add an annotation to the correct page", () => {
      const session = new TextAnnotationSession();
      session.add(mockAnnotation1);

      expect(session.page(1)).toEqual([mockAnnotation1]);
      expect(session.all()).toEqual([mockAnnotation1]);
    });

    it("should append annotations on the same page", () => {
      const session = new TextAnnotationSession([mockAnnotation1]);
      session.add(mockAnnotation3);

      expect(session.page(1)).toEqual([mockAnnotation1, mockAnnotation3]);
    });
  });

  describe("remove", () => {
    it("should remove and return the annotation if found", () => {
      const session = new TextAnnotationSession([mockAnnotation1, mockAnnotation2]);
      const removed = session.remove("a1");

      expect(removed).toEqual(mockAnnotation1);
      expect(session.page(1)).toEqual([]);
      expect(session.all()).toEqual([mockAnnotation2]);
    });

    it("should return undefined if annotation not found", () => {
      const session = new TextAnnotationSession([mockAnnotation1]);
      const removed = session.remove("unknown");

      expect(removed).toBeUndefined();
      expect(session.page(1)).toEqual([mockAnnotation1]);
    });
  });

  describe("replace", () => {
    it("should replace an existing annotation", () => {
      const session = new TextAnnotationSession([mockAnnotation1]);

      const updatedAnnotation: PdfTextAnnotation = {
        ...mockAnnotation1,
        text: "Updated Hello",
      };

      session.replace(updatedAnnotation);

      expect(session.page(1)).toEqual([updatedAnnotation]);
      expect(session.all()).toEqual([updatedAnnotation]);
      // Verify length hasn't changed
      expect(session.page(1)).toHaveLength(1);
    });

    it("should act as add if annotation to replace is not found", () => {
      const session = new TextAnnotationSession([mockAnnotation1]);
      session.replace(mockAnnotation2);

      expect(session.all()).toEqual([mockAnnotation1, mockAnnotation2]);
      expect(session.page(1)).toEqual([mockAnnotation1]);
      expect(session.page(2)).toEqual([mockAnnotation2]);
    });
  });

  describe("page", () => {
    it("should return annotations for a specific page", () => {
      const session = new TextAnnotationSession([mockAnnotation1, mockAnnotation2, mockAnnotation3]);

      expect(session.page(1)).toEqual([mockAnnotation1, mockAnnotation3]);
      expect(session.page(2)).toEqual([mockAnnotation2]);
    });

    it("should return an empty array if page has no annotations", () => {
      const session = new TextAnnotationSession([mockAnnotation1]);

      expect(session.page(99)).toEqual([]);
    });
  });

  describe("all", () => {
    it("should return all annotations flat", () => {
      const session = new TextAnnotationSession([mockAnnotation1, mockAnnotation2, mockAnnotation3]);

      // Order may depend on insertion/map iteration order, but length should be 3
      const all = session.all();
      expect(all).toHaveLength(3);
      expect(all).toContainEqual(mockAnnotation1);
      expect(all).toContainEqual(mockAnnotation2);
      expect(all).toContainEqual(mockAnnotation3);
    });
  });

  describe("clear", () => {
    it("should remove all annotations", () => {
      const session = new TextAnnotationSession([mockAnnotation1, mockAnnotation2]);
      session.clear();

      expect(session.all()).toEqual([]);
      expect(session.page(1)).toEqual([]);
      expect(session.page(2)).toEqual([]);
    });
  });
});
