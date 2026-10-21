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

## 2024-11-27 - Optimize Template Compilation, Vector Ranking, and Storage Asset Traversal

**Learning:** Found transient object and array allocations across hot prompt templating, memory vector search, and asset synchronization paths:

1. `applyChatTemplate` performed a full `safeStructuredClone(messages)` deep copy of the message list on every generation solely to update system roles in place, and re-instantiated/re-compiled Jinja templates from scratch.
2. `extractJSON` performed recursive string `.split(".")` and `.join(".")` at every level of nested path traversal, generating quadratic string and array allocations.
3. `HypaProcesser.similaritySearchVectorWithScore` and `HypaV3.similaritySearchSummaryChunkWithScore` allocated intermediate `{ similarity, index }` or `{ chunk, similarity }` objects and double-mapped arrays before sorting.
4. `chunkArray` in `hypamemory.ts` used `arr.reduce()` with `chunk.concat([elem])`, creating quadratic intermediate array copies per chunk.
5. `normalizeScores` in `hypav3.ts` allocated mapped score arrays and spread them across `Math.min(...scores)` and `Math.max(...scores)`, risking call-stack overflow on large candidate sets.
6. `manifestFingerprint` in `storageSyncCoordinator.ts` mapped new objects and JSON-stringified full arrays, while asset reader listing operations (`remoteSyncAssetReader`, `storageSyncAssetReader`, and `remoteBulkAssetClient`) used intermediate spreads and chained filters over large asset key sets.
7. `cleanColdStorage` evaluated `allKeys.filter((k) => !actualUsedKeys.includes(k))` with O(N*M) quadratic lookups, and `collectColdStorageBackupPayloads` instantiated `new TextEncoder()` on every single backup item.

**Action:**

1. Avoid deep-cloning prompt messages in `applyChatTemplate` by reading roles/contents immutably and cache compiled Jinja templates in a bounded LRU map.
2. Replace recursive path extraction in `extractJSON` with an iterative single-pass segment traversal, and use `Set.has()` in schema exclude filters.
3. Pre-allocate tuple result arrays directly in vector similarity searches, eliminating wrapper object allocations and redundant intermediate mapping passes.
4. Replace quadratic `chunk.concat([elem])` with linear `arr.slice()` chunks in `chunkArray`.
5. Compute min/max scores in `normalizeScores` via a single O(N) iterative pass without stack-spread operations.
6. Replace full JSON serialization in `manifestFingerprint` with key-sorted delimiter joins, and build unique prefix asset sets directly via `for...of` loops without intermediate spreads.
7. Use constant-time `Set.has()` for cold storage key pruning, and reuse a single `TextEncoder` instance across cold storage backup payload serialization.

## 2024-11-28 - Optimize Hot Pipeline Iterations, Micro-Allocations, and Memory Searches

**Learning:** Found transient array allocations, stack-overflow risks, and quadratic traversals across prompt preparation, memory engines, and data layers:
1. `chat.message.slice().reverse().find(...)` and `originalIds.slice(0, deletedIndex).reverse().find(...)` allocated and reversed full message/ID arrays where native `findLast` or reverse indexing avoids allocations entirely.
2. `chats.ts` sliced newest chat messages by cloning and reversing the entire chat history array `[...targetChat.message].reverse().slice(offset, count)`.
3. `loreMatchCacheKey` evaluated `JSON.stringify` and intermediate mapped/filtered arrays on every match check in tight loops, while `prepared.map` and `allMatches.map` were spread across `Math.max`.
4. `hypav3.ts` searched `data.summaries` using `!selectedSummaries.includes(e)` in 6 distinct filtering stages, resulting in repeated O(N * M) quadratic array scans.
5. `supaMemory.ts` executed quadratic `indexOf` deduplication and ran repeated regex punctuation replacements on `supaMemory` inside the per-chunk filter callback.
6. `hypamemoryv2.ts` executed quadratic `toEmbed.some()` in `ebdTexts.filter()`, and allocated null-tuple wrapper rows during vector search result formatting.
7. `tts.ts` built base64 audio via `audio.reduce((data, byte) => data + String.fromCharCode(byte), "")`, causing O(N^2) string allocations that freeze low-memory devices on audio processing.
8. `base64url` and `filesystemclient.ts` used `String.fromCharCode(...uint8Array)` or `String.fromCharCode.apply`, risking call-stack limits.
9. `characterStore` and `messageStore` used chained `flatMap`/`map`/`filter` operations and `[...needed].some()`.
10. `modules.ts` chained array `.concat(...)` and `.flatMap(...)` across character module, asset, trigger, script, and MCP collections.
11. `responses.ts` and `anthropic.ts` allocated intermediate `split().filter().map()` arrays in high-frequency SSE and batch JSONL parsers.

**Action:**
1. Replace `slice().reverse().find()` and `[...arr].reverse()` with `findLast()` or backward iteration loops without array cloning.
2. Replace MCP chat history reversal with direct backward window indexing.
3. Pre-serialize lorebook cache keys with delimiter-joined strings without `JSON.stringify`, and compute max depth/score via linear scans.
4. Maintain a companion `Set<Summary>` alongside `selectedSummaries` in HypaMemory V3 for constant-time O(1) membership checks.
5. Use a `Set` for deduplication and precompute stripped punctuation once outside the loop in SupaMemory.
6. Use Set-based IDs for O(1) embedding lookups and pre-allocated result rows in HypaMemory V2.
7. Use `Buffer.from(data).toString("base64")` / `toString("base64url")` with chunked fallback to eliminate O(N^2) string accumulation and prevent call-stack overflows.
8. Replace chained `map().filter()` and array spreads in domain stores and modules with single-pass accumulation loops and in-place pushes.
9. Parse SSE streaming data lines and batch JSONL directly in single-pass line loops without intermediate array allocations.
