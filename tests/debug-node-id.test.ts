import { describe, it, expect } from "vitest";
import { getDebugNodeId } from "../src/dom/debugNodeId";

describe("getDebugNodeId", () => {
  it("returns null for null or undefined", () => {
    expect(getDebugNodeId(null)).toBeNull();
    expect(getDebugNodeId(undefined)).toBeNull();
  });

  it("returns null for non-Node objects when Node is available", () => {
    // A plain object is not an instance of Node.
    const fakeNode = {} as EventTarget;
    expect(getDebugNodeId(fakeNode)).toBeNull();
  });

  it("returns a stable ID for the same DOM Node", () => {
    const node = document.createElement("div");
    const id1 = getDebugNodeId(node);
    const id2 = getDebugNodeId(node);

    expect(id1).toBeTypeOf("number");
    expect(id1).toBe(id2);
  });

  it("returns unique, sequential IDs for different DOM Nodes", () => {
    const node1 = document.createElement("span");
    const node2 = document.createElement("p");

    const id1 = getDebugNodeId(node1);
    const id2 = getDebugNodeId(node2);

    expect(id1).toBeTypeOf("number");
    expect(id2).toBeTypeOf("number");
    expect(id1).not.toBe(id2);
    // Note: Since these tests run after others, we can't assume id1 is exactly 1,
    // but we can assume id2 is exactly id1 + 1 (since they are created sequentially here).
    expect(id2).toBe((id1 as number) + 1);
  });
});
