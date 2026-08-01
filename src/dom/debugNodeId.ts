/** Stable per-node ids for debug logs (WeakMap — no DOM attributes). */
const nodeIds = new WeakMap<object, number>();
let nextNodeId = 1;

export function getDebugNodeId(node: EventTarget | null | undefined): number | null {
  if (!node || (typeof Node !== "undefined" && !(node instanceof Node))) return null;
  let id = nodeIds.get(node);
  if (id === undefined) {
    id = nextNodeId++;
    nodeIds.set(node, id);
  }
  return id;
}
