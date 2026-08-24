import { describe, it, expect, beforeEach } from 'vitest';
import {
  AddTextAnnotationCommand,
  DeleteTextAnnotationsCommand,
  ReplaceTextAnnotationCommand,
} from '../src/text/TextAnnotationCommands';
import { TextAnnotationSession } from '../src/text/TextAnnotationSession';
import type { PdfTextAnnotation } from '../src/model';

describe('TextAnnotationCommands', () => {
  let session: TextAnnotationSession;

  const mockAnnotation1: PdfTextAnnotation = {
    id: 'id-1',
    page: 1,
    text: 'Hello World',
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    color: '#000000',
    fontSize: 12,
    fontFamily: 'Helvetica',
    bold: false,
    italic: false,
    strikethrough: false,
    runs: [],
    sourceRuns: [],
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
  };

  const mockAnnotation2: PdfTextAnnotation = {
    id: 'id-2',
    page: 1,
    text: 'Another text',
    x: 100,
    y: 200,
    width: 200,
    height: 100,
    color: '#FF0000',
    fontSize: 14,
    fontFamily: 'Arial',
    bold: true,
    italic: false,
    strikethrough: false,
    runs: [],
    sourceRuns: [],
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
  };

  beforeEach(() => {
    session = new TextAnnotationSession();
  });

  describe('AddTextAnnotationCommand', () => {
    it('should add the text annotation to the session on execute', () => {
      const command = new AddTextAnnotationCommand(session, mockAnnotation1);

      expect(session.all()).toHaveLength(0);
      command.execute();

      expect(session.all()).toHaveLength(1);
      expect(session.all()[0]).toEqual(mockAnnotation1);
    });

    it('should remove the text annotation from the session on undo', () => {
      const command = new AddTextAnnotationCommand(session, mockAnnotation1);

      command.execute();
      expect(session.all()).toHaveLength(1);

      command.undo();
      expect(session.all()).toHaveLength(0);
    });
  });

  describe('DeleteTextAnnotationsCommand', () => {
    it('should remove the text annotations from the session on execute', () => {
      session.add(mockAnnotation1);
      session.add(mockAnnotation2);

      const command = new DeleteTextAnnotationsCommand(session, [mockAnnotation1, mockAnnotation2]);

      expect(session.all()).toHaveLength(2);
      command.execute();

      expect(session.all()).toHaveLength(0);
    });

    it('should restore the text annotations to the session on undo', () => {
      session.add(mockAnnotation1);
      session.add(mockAnnotation2);

      const command = new DeleteTextAnnotationsCommand(session, [mockAnnotation1, mockAnnotation2]);

      command.execute();
      expect(session.all()).toHaveLength(0);

      command.undo();

      const allAnnotations = session.all();
      expect(allAnnotations).toHaveLength(2);
      // Need to find them because they might be returned in different order if we look by map, though here it returns flattened array
      expect(allAnnotations).toContainEqual(mockAnnotation1);
      expect(allAnnotations).toContainEqual(mockAnnotation2);
    });
  });

  describe('ReplaceTextAnnotationCommand', () => {
    const updatedAnnotation1: PdfTextAnnotation = {
      ...mockAnnotation1,
      text: 'Updated Hello World',
    };

    it('should replace the old text annotation with the new one on execute', () => {
      session.add(mockAnnotation1);

      const command = new ReplaceTextAnnotationCommand(session, mockAnnotation1, updatedAnnotation1);

      expect(session.all()).toHaveLength(1);
      expect(session.all()[0]?.text).toBe('Hello World');

      command.execute();

      expect(session.all()).toHaveLength(1);
      expect(session.all()[0]?.text).toBe('Updated Hello World');
    });

    it('should restore the old text annotation on undo', () => {
      session.add(mockAnnotation1);

      const command = new ReplaceTextAnnotationCommand(session, mockAnnotation1, updatedAnnotation1);

      command.execute();
      expect(session.all()[0]?.text).toBe('Updated Hello World');

      command.undo();

      expect(session.all()).toHaveLength(1);
      expect(session.all()[0]?.text).toBe('Hello World');
    });
  });
});
