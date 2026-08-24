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
for (let i = 0; i < 100; i++) { // 100 pages
  for (let j = 0; j < 1000; j++) { // 1000 strokes per page
    session.add(createStroke(i, `stroke-${i}-${j}`));
  }
}

console.log(`Starting benchmark for all()...`);
const start = performance.now();
let count = 0;
for (let i = 0; i < 1000; i++) {
  const allStrokes = session.all();
  count += allStrokes.length;
}
const end = performance.now();
console.log(`Time taken: ${(end - start).toFixed(2)} ms. Count: ${count}`);
