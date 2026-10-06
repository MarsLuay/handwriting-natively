export interface PdfExtensionRegistrationResult {
  registered: boolean;
  error?: unknown;
}

/**
 * Obsidian may already own the PDF extension (notably in newer desktop
 * releases). Keep plugin startup alive when the host rejects an override; the
 * normal native-view scan can still attach handwriting sessions.
 */
export function tryRegisterPdfExtension(
  registerExtensions: (extensions: string[], viewType: string) => void,
  viewType: string
): PdfExtensionRegistrationResult {
  try {
    registerExtensions(["pdf"], viewType);
    return { registered: true };
  } catch (error) {
    return { registered: false, error };
  }
}
