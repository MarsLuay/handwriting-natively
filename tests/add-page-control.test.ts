import { describe, expect, it, vi } from "vitest";
import { AddPageControl } from "../src/ui/AddPageControl";

describe("AddPageControl", () => {
  function page(document: Document, number: number): HTMLElement {
    const element = document.createElement("div");
    element.className = "page";
    element.dataset.pageNumber = String(number);
    return element;
  }

  it("mounts after the highest numbered page with an accessible touch target", () => {
    const host = document.createElement("div");
    const first = page(document, 1);
    const last = page(document, 3);
    host.append(first, last);
    document.body.append(host);

    const control = new AddPageControl({
      enabled: () => true,
      isBusy: () => false,
      host: () => host,
      onCommit: vi.fn()
    }, document);

    expect(last.nextElementSibling?.className).toBe("native-pdf-handwriting-add-page");
    const button = host.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent).toBe("+ add page");
    expect(button?.getAttribute("aria-label")).toBe("Add page");
    expect(button?.disabled).toBe(false);
    control.destroy();
  });

  it("debounces rapid activation and repositions after a new final page appears", async () => {
    const host = document.createElement("div");
    const last = page(document, 1);
    host.append(last);
    document.body.append(host);
    let resolveCommit: (() => void) | undefined;
    const commit = vi.fn(() => new Promise<void>((resolve) => { resolveCommit = resolve; }));
    const control = new AddPageControl({
      enabled: () => true,
      isBusy: () => false,
      host: () => host,
      onCommit: commit
    }, document);
    const button = host.querySelector<HTMLButtonElement>("button")!;

    button.click();
    button.click();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);

    const newLast = page(document, 2);
    host.append(newLast);
    control.refresh();
    expect(newLast.nextElementSibling).toBe(button);

    resolveCommit!();
    await Promise.resolve();
    expect(button.disabled).toBe(false);
    control.destroy();
  });

  it("does not expose a control when the capability is disabled or busy", () => {
    const host = document.createElement("div");
    host.append(page(document, 1));
    document.body.append(host);
    let enabled = false;
    const control = new AddPageControl({
      enabled: () => enabled,
      isBusy: () => true,
      host: () => host,
      onCommit: vi.fn()
    }, document);
    expect(host.querySelector("button")).toBeNull();

    enabled = true;
    control.refresh();
    const button = host.querySelector<HTMLButtonElement>("button");
    expect(button?.disabled).toBe(true);
    control.destroy();
  });
});
