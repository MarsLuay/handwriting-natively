import { InkSession } from "./src/ink/InkSession";
import type { InkStroke } from "./src/model";

// Create a dummy stroke factory
const createStroke = (page: number, id: string): InkStroke => ({
  id,
  page,
  points: [],
  color: "black",
  size: 1,
  type: "pen"
} as any);

const session = new InkSession();
for (let i = 0; i < 100; i++) {
  for (let j = 0; j < 1000; j++) {
    session.add(createStroke(i, `stroke-${i}-${j}`));
  }
}

// Warmup
for (let i = 0; i < 100; i++) {
  session.all();
}

console.log(`Starting benchmark for original all()...`);
let start = performance.now();
for (let i = 0; i < 1000; i++) {
  const allStrokes = [...(session as any).byPage.values()].flat();
}
let end = performance.now();
console.log(`[...values()].flat() Time taken: ${(end - start).toFixed(2)} ms.`);


console.log(`Starting benchmark for push...`);
start = performance.now();
for (let i = 0; i < 1000; i++) {
  const result: InkStroke[] = [];
  for (const strokes of (session as any).byPage.values()) {
    result.push(...strokes);
  }
}
end = performance.now();
console.log(`push Time taken: ${(end - start).toFixed(2)} ms.`);


console.log(`Starting benchmark for flatMap...`);
start = performance.now();
for (let i = 0; i < 1000; i++) {
  const result = Array.from((session as any).byPage.values()).flatMap(x => x);
}
end = performance.now();
console.log(`Array.from.flatMap Time taken: ${(end - start).toFixed(2)} ms.`);
