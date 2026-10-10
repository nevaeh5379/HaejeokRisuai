## 2024-05-24 - Deep Cloning Performance
**Learning:** Native `structuredClone` and `JSON.parse(JSON.stringify())` have performance/compatibility issues in this environment. The codebase has a custom `safeStructuredClone` in `src/ts/polyfill.ts` that falls back to `rfdc` (Really Fast Deep Clone) which is highly optimized for this stack.
**Action:** Always use `safeStructuredClone` from `src/ts/polyfill.ts` for deep cloning instead of native methods.
