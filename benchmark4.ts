import { InkSession } from "./src/ink/InkSession";
import type { InkStroke } from "./src/model";

const session = new InkSession();
for (let i = 0; i < 100; i++) {
  for (let j = 0; j < 1000; j++) {
    session.add({ id: `stroke-${i}-${j}`, page: i, points: [], color: "black", size: 1, type: "pen" } as any);
  }
}

// Warmup
for (let i = 0; i < 100; i++) {
  [...(session as any).byPage.values()].flat();
}

console.log(`Starting benchmark for original all()...`);
let start = performance.now();
for (let i = 0; i < 1000; i++) {
  const allStrokes = [...(session as any).byPage.values()].flat();
}
let end = performance.now();
console.log(`[...values()].flat() Time taken: ${(end - start).toFixed(2)} ms.`);

console.log(`Starting benchmark for flatMap iterator...`);
start = performance.now();
for (let i = 0; i < 1000; i++) {
  const allStrokes = Array.from((session as any).byPage.values()).flatMap(x => x);
}
end = performance.now();
console.log(`Array.from().flatMap() Time taken: ${(end - start).toFixed(2)} ms.`);

console.log(`Starting benchmark for iterator flatMap...`);
start = performance.now();
for (let i = 0; i < 1000; i++) {
  // Using custom flatMap since Iterator.prototype.flatMap is new and might not be available
  const result: InkStroke[] = [];
  for (const strokes of (session as any).byPage.values()) {
    result.push(...strokes);
  }
}
end = performance.now();
console.log(`push Time taken: ${(end - start).toFixed(2)} ms.`);
