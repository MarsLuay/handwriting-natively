import { describe, expect, it } from "vitest";
import {
  PlatformCapabilities,
  probePlatformCapabilities,
  type IntegrationPlatform
} from "../src/integration/PlatformCapabilities";
import { PdfViewerCompatibility } from "../src/integration/PdfViewerCompatibility";

function hostWithPage(): HTMLElement {
  const host = document.createElement("div");
  const viewer = document.createElement("div");
  viewer.className = "pdf-viewer";
  const page = document.createElement("div");
  page.className = "page";
  page.dataset.pageNumber = "1";
  page.append(document.createElement("canvas"));
  viewer.append(page);
  host.append(viewer);
  return host;
}

describe("platform and PDF compatibility evidence", () => {
  it.each([
    ["desktop", "1.8.10", false, false, "raw-pdfjs"],
    ["android", "1.8.10", true, true, "raw-pdfjs"],
    ["ipad", "1.7.7", true, false, "obsidian-wrapper"]
  ] as const)("keeps explicit %s host/version inputs separate", (platform, version, isMobile, isPhone, graph) => {
    const report = probePlatformCapabilities({
      platform,
      obsidianVersion: version,
      isMobile,
      isPhone,
      runtime: {
        pointerEvents: true,
        touchEvents: isMobile,
        mutationObserver: true,
        resizeObserver: true
      }
    });

    expect(report).toMatchObject({
      platform,
      platformEvidence: "explicit-host-signal",
      obsidianVersion: version,
      versionEvidence: "explicit-api-version",
      isMobile,
      isPhone,
      viewerGraphEra: graph,
      isIdentified: true
    });
    expect(report.runtime.touchEvents).toBe(isMobile ? "available" : "unavailable");
  });

  it("does not infer a platform or version from jsdom/user-agent-shaped inputs", () => {
    const report = PlatformCapabilities.probe({
      runtime: { pointerEvents: true, touchEvents: true }
    });

    expect(report.platform).toBe("unknown");
    expect(report.obsidianVersion).toBeNull();
    expect(report.viewerGraphEra).toBe("unknown");
    expect(report.isIdentified).toBe(false);
  });

  it("keeps malformed version evidence fail-closed", () => {
    const report = probePlatformCapabilities({
      platform: "android",
      obsidianVersion: "current-mobile-build",
      runtime: { pointerEvents: true }
    });

    expect(report.platform).toBe("android");
    expect(report.obsidianVersion).toBeNull();
    expect(report.versionEvidence).toBe("unknown");
    expect(report.viewerGraphEra).toBe("unknown");
    expect(report.isIdentified).toBe(false);
  });

  it("does not extrapolate private viewer paths to an unknown major version", () => {
    const report = probePlatformCapabilities({
      platform: "desktop",
      obsidianVersion: "2.0.0"
    });

    expect(report.obsidianVersion).toBe("2.0.0");
    expect(report.viewerGraphEra).toBe("unknown");
    expect(report.viewerGraphEvidence).toBe("unknown");
  });

  it("reports the explicit object observation instead of upgrading a version guess", () => {
    const report = probePlatformCapabilities({
      platform: "ipad",
      obsidianVersion: "1.8.10",
      viewerGraphEra: "obsidian-wrapper"
    });

    expect(report.viewerGraphEra).toBe("obsidian-wrapper");
    expect(report.viewerGraphEvidence).toBe("explicit-object-observation");
  });

  it("carries platform evidence through the compatibility boundary", () => {
    const host = hostWithPage();
    const platform: IntegrationPlatform = "desktop";
    const report = probePlatformCapabilities({ platform, obsidianVersion: "1.8.10" });
    const result = PdfViewerCompatibility.direct(host, undefined, undefined, report);

    expect(result.compatible).toBe(true);
    expect(result.platform).toBe(report);
    expect(result.profile).toMatchObject({
      schemaVersion: 1,
      adapter: "direct",
      status: "supported-with-fallback",
      viewerGeneration: 1,
      capabilities: {
        viewerRoot: true,
        pageElements: true,
        trustworthyPageNumbers: true,
        geometryReadable: true,
        scrollRoot: true,
        embedded: false
      },
      counters: {
        rebinds: 0,
        viewerReplacements: 0,
        pageReplacements: 0,
        fallbackUses: 1,
        attachRetries: 0
      }
    });
  });

  it("fails closed for missing viewer roots and rendered pages", () => {
    const missingRoot = PdfViewerCompatibility.direct(document.createElement("div"));
    expect(missingRoot.compatible).toBe(false);
    expect(missingRoot.profile.status).toBe("unsafe");
    expect(missingRoot.profile.capabilities).toMatchObject({
      viewerRoot: false,
      pageElements: false,
      geometryReadable: false,
      pageReplacementObservable: false
    });
    expect(missingRoot.profile.counters).toEqual({
      rebinds: 0,
      viewerReplacements: 0,
      pageReplacements: 0,
      fallbackUses: 1,
      attachRetries: 0
    });
    expect(missingRoot.profile.failedProbes).toEqual([expect.stringContaining("PDF viewer root missing")]);
    expect(missingRoot.errors).toEqual([expect.stringContaining("PDF viewer root missing")]);

    const missingPage = document.createElement("div");
    const viewer = document.createElement("div");
    viewer.className = "pdf-viewer";
    missingPage.append(viewer);
    const result = PdfViewerCompatibility.direct(missingPage);
    expect(result.compatible).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining("PDF page nodes missing")]);
  });
});
