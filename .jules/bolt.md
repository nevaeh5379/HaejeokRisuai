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

## 2024-11-28 - Optimize Parser, Inlay Codec, and Template Range Allocations

**Learning:** Found quadratic memory allocations and unnecessary intermediate arrays in hot text parsing and file decoding routines:

1. `getDistance` (Levenshtein distance) in `parser.svelte.ts` allocated a full 2D matrix of `(a.length + 1) * (b.length + 1)` in `Int16Array`, which for string matching across asset lists repeatedly allocated thousands of integer elements.
2. `trimmer` in `parser.svelte.ts` re-instantiated a 13-element string array and string-concatenated extensions on every call.
3. `risuChatParser` in `parser.svelte.ts` performed single-character string appends in a loop for all plain text, and allocated unused `commentLatest`, `commentV`, and tracking structures on every invocation.
4. `trimLines` repeatedly split, mapped, joined, and trimmed multiline strings, while `blockEndMatcher` split full texts on newline solely to check if `lines.length === 1`.
5. `base64ToBlob` in `inlays.ts` used `atob` with an element-by-element `charCodeAt` copy loop and `ArrayBuffer` allocation instead of `Buffer.from(b64, 'base64')`, and split headers twice to find the MIME type.
6. `templateCheck` in `templateCheck.ts` computed unresolved ranges via `startRanges.filter(...includes...).concat(endRanges.filter(...includes...))`, performing O(N^2) searches and allocating intermediate arrays.
7. `parseChatML` in `chatML.ts` used `.split(starter).filter(...).map(...)`, allocating intermediate filtered arrays, and concatenated separator prefixes on every iteration.
8. `getChatVar` in `chatVar.svelte.ts` concatenated character and template default variable lists instead of searching the character defaults first.

**Action:**

1. Implement Wagner-Fischer Levenshtein distance using a single 1D row vector of length `min(a.length, b.length) + 1` with short-circuiting for identity and empty strings.
2. Hoist `TRIMMER_EXTENSIONS` to module constants and terminate extension inspection on the first match.
3. Add a fast path to `risuChatParser` for plain text containing no tags, remove dead comment/thinking structures, and chunk non-special spans via `slice`.
4. Replace `trimLines` with regex-based leading whitespace stripping, and check `!p1.includes('\n')` before line splitting in `blockEndMatcher`.
5. Decode base64 to Blob directly via `Buffer.from` in `base64ToBlob` and parse MIME string with `indexOf`.
6. Convert `templateCheck` range overlap lookups to `Set.has()` checks in linear time.
7. Replace chained `.split().filter().map()` in `parseChatML` with a single-pass loop and hoisted separator constants.
8. Search character default variables prior to parsing preset template variables in `getChatVar`, avoiding array concatenations.
