/** Rewrites the cross-language fixtures: `bun test/fixtures/write.ts` from packages/sdk. */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewVector, sealedVector } from "./vectors.js";

const dir = import.meta.dir;
writeFileSync(join(dir, "sealed.json"), `${JSON.stringify(sealedVector(), null, 2)}\n`);
writeFileSync(join(dir, "review.json"), `${JSON.stringify(reviewVector(), null, 2)}\n`);
console.log("wrote sealed.json and review.json");
