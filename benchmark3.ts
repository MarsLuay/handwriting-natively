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
  [...(session as any).byPage.values()].flat();
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

console.log(`Starting benchmark for manual loop with pre-allocation...`);
start = performance.now();
for (let i = 0; i < 1000; i++) {
  let len = 0;
  for (const strokes of (session as any).byPage.values()) len += strokes.length;
  const result: InkStroke[] = new Array(len);
  let k = 0;
  for (const strokes of (session as any).byPage.values()) {
    for (const stroke of strokes) {
        result[k++] = stroke;
    }
  }
}
end = performance.now();
console.log(`manual loop with pre-allocation Time taken: ${(end - start).toFixed(2)} ms.`);


console.log(`Starting benchmark for manual loop with pre-allocation and array copy...`);
start = performance.now();
for (let i = 0; i < 1000; i++) {
  let len = 0;
  for (const strokes of (session as any).byPage.values()) len += strokes.length;
  const result: InkStroke[] = new Array(len);
  let k = 0;
  for (const strokes of (session as any).byPage.values()) {
    for(let j=0; j<strokes.length; j++) {
        result[k++] = strokes[j];
    }
  }
}
end = performance.now();
console.log(`manual loop with pre-allocation & traditional array loop Time taken: ${(end - start).toFixed(2)} ms.`);
