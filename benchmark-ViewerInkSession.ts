const NUM_PAGES = 1000;

const pages = Array.from({ length: NUM_PAGES }, (_, i) => ({
  pageNumber: i + 1,
  element: {
    isConnected: true,
    contains: () => true
  }
}));

const surfaces = new Map();
for (let i = 1; i <= NUM_PAGES; i++) {
  surfaces.set(i, {
    overlay: { isConnected: true },
    page: { element: { isConnected: true } }
  });
}

function runOriginal() {
  const start = performance.now();
  for (let iter = 0; iter < 100; iter++) {
    const detachedOverlayPages = [...surfaces.entries()]
      .filter(([pageNumber, surface]) => !surface.overlay.isConnected && pages.some((page) => page.pageNumber === pageNumber && page.element.isConnected))
      .map(([pageNumber]) => pageNumber);

    const driftedPageElements = [...surfaces.entries()]
      .filter(([pageNumber, surface]) => {
        const live = pages.find((page) => page.pageNumber === pageNumber);
        return Boolean(live && live.element !== surface.page.element && live.element.isConnected);
      })
      .map(([pageNumber]) => pageNumber);

    const reattachCandidates = [...new Set([...detachedOverlayPages, ...driftedPageElements])];

    // Assuming some elements need reattach to trigger the block
    const mockReattached = true;
    const reattachCandidatesMock = Array.from({length: NUM_PAGES}, (_, i) => i + 1);

    const reattachedOverlayPages = mockReattached
      ? reattachCandidatesMock.filter((pageNumber) => {
        const surface = surfaces.get(pageNumber);
        const live = pages.find((page) => page.pageNumber === pageNumber);
        return Boolean(
          surface
          && live
          && surface.page.element === live.element
          && surface.overlay.isConnected
          && live.element.contains(surface.overlay)
        );
      })
      : [];
  }
  const end = performance.now();
  console.log(`Original Time taken: ${(end - start).toFixed(2)} ms.`);
}

function runOptimized() {
  const start = performance.now();
  for (let iter = 0; iter < 100; iter++) {
    const pagesMap = new Map(pages.map(p => [p.pageNumber, p]));
    const detachedOverlayPages = [...surfaces.entries()]
      .filter(([pageNumber, surface]) => {
        const page = pagesMap.get(pageNumber);
        return !surface.overlay.isConnected && page && page.element.isConnected;
      })
      .map(([pageNumber]) => pageNumber);

    const driftedPageElements = [...surfaces.entries()]
      .filter(([pageNumber, surface]) => {
        const live = pagesMap.get(pageNumber);
        return Boolean(live && live.element !== surface.page.element && live.element.isConnected);
      })
      .map(([pageNumber]) => pageNumber);

    const reattachCandidates = [...new Set([...detachedOverlayPages, ...driftedPageElements])];

    const mockReattached = true;
    const reattachCandidatesMock = Array.from({length: NUM_PAGES}, (_, i) => i + 1);

    const reattachedOverlayPages = mockReattached
      ? reattachCandidatesMock.filter((pageNumber) => {
        const surface = surfaces.get(pageNumber);
        const live = pagesMap.get(pageNumber);
        return Boolean(
          surface
          && live
          && surface.page.element === live.element
          && surface.overlay.isConnected
          && live.element.contains(surface.overlay)
        );
      })
      : [];
  }
  const end = performance.now();
  console.log(`Optimized Time taken: ${(end - start).toFixed(2)} ms.`);
}

runOriginal();
runOptimized();
