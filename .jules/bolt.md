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

## 2024-11-25 - Eliminate Allocation Hotpaths in Loops and Touch Handlers

**Learning:** Found nested spread operations and array conversions inside hot iteration paths, such as `[...lastSummary.chatMemos].at(-1)` evaluated inside `chats.findIndex()`, `[...touchPointers.values()]` inside pinch zoom pointer move handlers, and `[...baseMessages].reverse().find()` in speaker resolution. These create O(N*M) GC pressure and micro-stutters on low-memory mobile devices.
**Action:** Extract loop-invariant lookups before iteration loops (retrieving the last Set item in a single pass outside `findIndex`), use iterator `next()` instead of array spread when only leading values are needed, replace `[...arr].reverse().find()` with `arr.findLast()`, and replace transient filter arrays with early-return loop checks or single-pass `Array.from()` conversions. When the same block already exists in twin functions (`hypaMemoryV3MainExp`/`hypaMemoryV3Main`, or `startPinch` and the pinch pointermove branch), extract one shared helper instead of copying the optimized block twice; a reusable output holder (`pinchPoints`) keeps the shared helper allocation-free.

## 2024-11-26 - Chat Core Pipeline and Workflow Graph Micro-Allocations

**Learning:** Found multiple multi-pass mapping patterns (`map().filter().map()`) in generation window compaction, prompt memory policy, and Cohere conversation history, creating 3-4 intermediate arrays and transient wrapper objects on every model request. In ComfyUI workflow graph operations and execution DTO resolution, `[...map.values()].find(...)` was copying entire node and link collections just to locate a single element. In group speaker resolution, candidate names were repeatedly split into words via regex inside nested loops, causing $O(W \times C)$ transient string array allocations.
**Action:** Consolidate multi-pass filter/map pipelines into single-pass loops with direct accumulation. Use direct `for...of map.values()` iteration for early-exit lookups instead of spreading map values into an array. Pre-compute candidate name token Sets once before nested message-word matching loops. Use single-pass partitioning instead of double-filtering with `!directLocs.includes(loc)`. Replace `slice(1)` loops with index-based loops to avoid array copies.
