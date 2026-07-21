import type { VaultLogLevel } from "../logging/VaultLogSink";
import type { ViewStateSource } from "../logging/SessionLogger";
import type { PdfPageInfo } from "./PdfPageLocator";
import type { ToolbarPlacement } from "../model";

export interface PdfViewState {
  pageNumber: number;
  scrollFraction: number;
  scale: number;
  rotation: number;
}

export interface PdfAdapterCallbacks {
  onViewStateChange?(state: PdfViewState, source: ViewStateSource): void;
  onPagesChanged?(reason: string): void;
  /** PDF.js replaced page contents (canvas/text layer) without replacing a page node. */
  onPageContentMutation?(recordCount: number): void;
  onCompatibilityWarning?(message: string): void;
  /** Optional vault debug sink (respects settings.vaultDebugLog). */
  onDebugLog?(level: VaultLogLevel, event: string, payload?: Record<string, unknown>): void;
}

export interface ObsidianPdfAdapter {
  readonly kind: "direct" | "embedded";
  readonly host: HTMLElement;
  readonly root: HTMLElement;
  pages(): PdfPageInfo[];
  /** O(1) page lookup — prefer over `pages()` when only a few mounts are needed. */
  page(pageNumber: number): PdfPageInfo | undefined;
  getViewState(): PdfViewState;
  restoreViewState(state: PdfViewState): void;
  scrollElement(): HTMLElement;
  mountOverlay(pageNumber: number): HTMLElement;
  mountToolbar(toolbar: HTMLElement, placement?: ToolbarPlacement): void;
  /** Advanced opt-in only; normal PDF zoom stays under Obsidian's default cap. */
  setBoostedZoom?(enabled: boolean): void;
  compatibilityReport(): { errors: string[]; warnings: string[] };
  destroy(): void;
}

export class PdfAdapterCompatibilityError extends Error {
  constructor(kind: "direct" | "embedded", reasons: string[]) {
    super(`${kind} PDF adapter incompatible: ${reasons.join("; ")}`);
    this.name = "PdfAdapterCompatibilityError";
  }
}
