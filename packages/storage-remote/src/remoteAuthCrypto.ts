import { p256 } from "@noble/curves/nist.js";

// Auth tokens are cached for minutes. Prefer smaller precompute tables over
// maximum signing throughput on memory-constrained mobile devices.
p256.Point.BASE.precompute(4);

export { p256 };
