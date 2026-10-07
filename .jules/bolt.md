## 2023-10-27 - Centralized safeStructuredClone
**Learning:** Found instances of `JSON.parse(JSON.stringify())` and raw `structuredClone` being used for deep cloning instead of the centralized `safeStructuredClone` utility which uses `rfdc` for better performance.
**Action:** Always prefer `safeStructuredClone` from `src/ts/polyfill.ts` for deep cloning objects in this codebase to ensure better performance (2-3x speedup) and consistency, especially important for constrained devices.
