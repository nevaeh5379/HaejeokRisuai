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

## 2024-11-20 - List Image Performance

**Learning:** Native image lazy loading avoids eager downloads for URL-backed list images, but does not defer application reads that have already created Blob URLs. Storage Explorer must defer the thumbnail read itself, including any parent preloading.
**Action:** Use a shared IntersectionObserver to request bot avatars near the viewport, retain native lazy loading and async decoding on list images, and discard unfinished thumbnail results when storage changes or the explorer closes.

## 2024-05-19 - Stable Keys in Dynamic Mobile and Sidebar Lists

**Learning:** Sorting, filtering, and virtual scrolling need row identity tied to the character or chat rather than its current array position. Old records can still lack IDs.
**Action:** Prefer persistent character/chat IDs as each-block keys and fall back to the record object when an ID is missing. Keep event handlers using the original store index, and verify node identity and Sortable drag synchronization with behavioral tests.

## 2024-11-21 - Remove Unnecessary Spread Collections

**Learning:** Found instances of `[...clients]` and `[...subscriptions.values()]` being spread inside `for...of` loops and `JSON.stringify`, leading to unnecessary Array allocations that strain memory constraints on Android environments and GC times. Iterating directly over `Map.values()` or `Set` objects using `for...of` prevents memory allocations without losing function. `Set.delete()` or `Map.delete()` inside an active loop is completely valid in JS.
**Action:** Replace spread iteration expressions such as `for (const x of [...set])` with direct iterations `for (const x of set)` when possible. Substitute chained array mapping combinations like `[...iterable].map(...)` with `Array.from(iterable, ...)` to perform mapping alongside array conversion directly.

## 2026-10-21 - Vector Index Eviction & Bound Iteration Optimization

**Learning:** In `server/node/util/vectorIndex.ts`, `evictMemoryIndexes` invoked `oldestCandidates()[0]` repeatedly within a `while (indexes.size > MAX_INDEXES)` loop. This re-collected, filtered, and sorted the entire index map on every eviction step (`O(N^2 log N)` allocation). Additionally, `Array.from(indexes.values()).reduce(...)` allocated a transient array for calculating float sums, and `searchVectorIndex` converted all map entries into an array of 2-element tuples `Array.from(index.vectors.entries())` even when only a small topK (<= 64) window was needed. Similarly, `Math.max(...array.map(...))` and `Math.min(...timestamps)` spread array arguments onto the call stack and created unnecessary intermediate mapped arrays.
**Action:** In `server/node/util/vectorIndex.ts`, replace repeated sorting inside the eviction loop with an `O(N)` linear min-scan, iterate `indexes.values()` directly for float counting, and pass `index.vectors` directly to `rankVectors` so entry tuples are never allocated when maintaining small topK windows. In `moduleRequestRules.ts`, `taskRateLimiter.ts`, and `DbStatsTab.svelte`, replace `Math.max(...map(...))` and `Math.min(...)` with direct linear iterations or chronological queue head lookups. Prefer `TextDecoder.decode()` over `Buffer.from().toString()` for stringified file decoding.
