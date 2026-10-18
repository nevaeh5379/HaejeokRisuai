## 2023-10-27 - Centralized safeStructuredClone
**Learning:** Found instances of `JSON.parse(JSON.stringify())` and raw `structuredClone` being used for deep cloning instead of the centralized `safeStructuredClone` utility which uses `rfdc` for better performance.
**Action:** Always prefer `safeStructuredClone` from `src/ts/polyfill.ts` for deep cloning objects in this codebase to ensure better performance (2-3x speedup) and consistency, especially important for constrained devices.
## 2024-05-18 - Map Keys Array Spread Bottleneck
**Learning:** Avoid using `[...map.keys()]` or `[...map.entries()]` to find items, particularly inside loops like cache eviction (e.g., `while (this.size > maxEntries) { [...super.keys()].find(...) }`). Iterating directly with `for (const key of map.keys())` is dramatically faster because it avoids creating full array copies on every iteration. Deleting elements from a Map while iterating via `for...of map.keys()` is safe and supported in JavaScript.
**Action:** Replace `[...map.keys()].find(...)` and `for (const key of [...map.keys()])` with direct `for...of` loops, maintaining `break` logic for efficiency.
## 2024-05-14 - Replace JSON.parse(JSON.stringify) with structuredClone
**Learning:** Found usage of JSON.parse(JSON.stringify()) for deep cloning in some files, despite a safeStructuredClone polyfill being available. structuredClone is generally faster for deep cloning and can handle more types (like Map, Set, Date, RegExp, etc) than JSON stringification.
**Action:** Replace JSON.parse(JSON.stringify()) with safeStructuredClone in src/ts/cbs.ts and src/ts/process/request/openAI/responses.ts.
## 2024-05-24 - Deep Cloning Performance
**Learning:** Native `structuredClone` and `JSON.parse(JSON.stringify())` have performance/compatibility issues in this environment. The codebase has a custom `safeStructuredClone` in `src/ts/polyfill.ts` that falls back to `rfdc` (Really Fast Deep Clone) which is highly optimized for this stack.
**Action:** Always use `safeStructuredClone` from `src/ts/polyfill.ts` for deep cloning instead of native methods.
## 2024-05-25 - Avoid Map Entries Array Spread for Min/Max finding
**Learning:** Found an instance in `server/node/executors/hypaMemoryExecutor.ts` where `[...sessions.entries()].sort(...)` was used inside a `while` loop to find the oldest session to evict. This creates an `O(N log N)` sort operation and allocates a new array for every single eviction, causing significant GC pressure and performance degradation.
**Action:** Replace spreading and sorting of maps (like `[...map.entries()].sort()`) to find a single minimum/maximum item with a linear `for...of` loop (`O(N)`).
## 2026-10-14 - Array Spread Replaced with Iterators
**Learning:** In `src/ts/gui/branches.ts`, spreading map values into arrays for filtering and counting (e.g. `[...map.values()]`) caused unnecessary memory allocation, especially for large datasets. This is a common performance anti-pattern.
**Action:** Replaced array spreading and mapping/filtering chains with direct `for...of` iterators over maps to avoid intermediate array creation.
