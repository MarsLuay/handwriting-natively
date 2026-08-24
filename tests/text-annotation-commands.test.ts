import { describe, it, expect, vi } from "vitest";
import { ReplaceTextAnnotationCommand } from "../src/text/TextAnnotationCommands";
import type { TextAnnotationSession } from "../src/text/TextAnnotationSession";
import type { PdfTextAnnotation } from "../src/model";

describe("ReplaceTextAnnotationCommand", () => {
    it("should replace before with after on execute", () => {
        const session = {
            replace: vi.fn(),
            add: vi.fn(),
            remove: vi.fn()
        } as unknown as TextAnnotationSession;

        const before: PdfTextAnnotation = { id: "1", text: "before" } as any;
        const after: PdfTextAnnotation = { id: "1", text: "after" } as any;

        const command = new ReplaceTextAnnotationCommand(session, before, after);

        command.execute();

        expect(session.replace).toHaveBeenCalledWith(after);
    });

    it("should replace after with before on undo", () => {
        const session = {
            replace: vi.fn(),
            add: vi.fn(),
            remove: vi.fn()
        } as unknown as TextAnnotationSession;

        const before: PdfTextAnnotation = { id: "1", text: "before" } as any;
        const after: PdfTextAnnotation = { id: "1", text: "after" } as any;

        const command = new ReplaceTextAnnotationCommand(session, before, after);

        command.undo();

        expect(session.replace).toHaveBeenCalledWith(before);
    });

    it("should have correct label", () => {
        const session = {} as unknown as TextAnnotationSession;
        const before: PdfTextAnnotation = {} as any;
        const after: PdfTextAnnotation = {} as any;

        const command = new ReplaceTextAnnotationCommand(session, before, after);

        expect(command.label).toBe("Edit text annotation");
    });
});
