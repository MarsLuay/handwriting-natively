import { describe, expect, it } from "vitest";
import { tryRegisterPdfExtension } from "../src/integration/PdfExtensionRegistration";

describe("PDF extension registration", () => {
  it("reports success when Obsidian accepts the override", () => {
    const calls: Array<{ extensions: string[]; viewType: string }> = [];
    const result = tryRegisterPdfExtension((extensions, viewType) => {
      calls.push({ extensions, viewType });
    }, "native-pdf-handwriting-view");

    expect(result).toEqual({ registered: true });
    expect(calls).toEqual([{ extensions: ["pdf"], viewType: "native-pdf-handwriting-view" }]);
  });

  it("keeps startup recoverable when Obsidian already owns pdf", () => {
    const error = new Error('Attempting to register an existing file extension "pdf"');
    const result = tryRegisterPdfExtension(() => {
      throw error;
    }, "native-pdf-handwriting-view");

    expect(result.registered).toBe(false);
    expect(result.error).toBe(error);
  });
});
