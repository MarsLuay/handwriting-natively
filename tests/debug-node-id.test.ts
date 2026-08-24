import { describe, it, expect } from "vitest";
import { getDebugNodeId } from "../src/dom/debugNodeId";

describe("getDebugNodeId", () => {
  it("returns null for null or undefined", () => {
    expect(getDebugNodeId(null)).toBeNull();
    expect(getDebugNodeId(undefined)).toBeNull();
  });

  it("returns null for non-Node objects", () => {
    // A plain object that is typed as an EventTarget to mock an incompatible type
    const nonNode = {} as EventTarget;
    expect(getDebugNodeId(nonNode)).toBeNull();

    // A class that extends EventTarget but is not a Node
    class CustomTarget extends EventTarget {}
    const customTarget = new CustomTarget();
    expect(getDebugNodeId(customTarget)).toBeNull();
  });

  it("returns a stable numeric ID for a valid DOM Node", () => {
    const div = document.createElement("div");

    const id1 = getDebugNodeId(div);
    expect(typeof id1).toBe("number");

    // Calling it again on the same node should return the exact same ID
    const id2 = getDebugNodeId(div);
    expect(id2).toBe(id1);
  });

  it("returns different IDs for different Nodes", () => {
    const div1 = document.createElement("div");
    const div2 = document.createElement("span");
    const textNode = document.createTextNode("hello");

    const id1 = getDebugNodeId(div1);
    const id2 = getDebugNodeId(div2);
    const id3 = getDebugNodeId(textNode);

    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id2).not.toBe(id3);

    // Assert all are numbers
    expect(typeof id1).toBe("number");
    expect(typeof id2).toBe("number");
    expect(typeof id3).toBe("number");
  });
});
