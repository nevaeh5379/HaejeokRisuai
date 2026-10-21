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

## 2024-11-28 - Optimize Korean Search Matching, Media Compression, and Asset Resolution Allocations

**Learning:** Found repeated regex compilation, heavy string decomposition, and memory allocations in frequent UI search and media processing paths:

1. `matchCharacterKorean` repeatedly performed query NFC normalization, dynamic RegExp compilation, `disassemble()`, `romanize()`, `convertQwertyToHangul()`, and `normalizePhonetic()` for each candidate character and tag during character list filtering in `MainMenu.svelte`. For 500 characters and multiple tags, this created thousands of temporary regexes and strings per keystroke, degrading typing responsiveness on 4GB mobile devices.
2. `charToPattern` performed linear searches with `CHOSEONG_LIST.indexOf(ch)` and allocated a new `batchimExpansions` object literal on every single character evaluation.
3. `doLossyCompression` serialized full binary images to multi-megabyte `data:image/png;base64,...` data URLs before setting `image.src`, causing excessive heap spike and GC pressure. Additionally, quality `75` was passed to `toDataURL` instead of standard `0.75` (valid range: 0.0 - 1.0), and `base64.split(",")` created transient string arrays.
4. `generateClientThumbnail` used `dataUrl.split(",")[1]`, allocating unnecessary intermediate string arrays.
5. `hasher` allocated `Buffer` wrappers via `Buffer.from(...).toString("hex")` in web/mobile environments instead of fast byte-to-hex table conversions.
6. `resolveCurrentChatAsset` created transient arrays via `getModuleAssets().concat(additionalAssets ?? [])` and used locale-dependent `toLocaleLowerCase()`.
7. `requestOpenAI` logged `console.log(formatedChat)` in production requests, adding needless IO and object serialization.

**Action:**

1. Introduce `createKoreanMatcher(query)` which precomputes regex compilation, phonetic variants, and jamo decomposition once per query, and use `matcher.matchCharacter(item.char)` directly in `MainMenu.svelte`.
2. Use a module-level `CHOSEONG_INDEX_MAP` for O(1) lookup and hoist `BATCHIM_EXPANSIONS` as a frozen module constant.
3. Prefer `URL.createObjectURL(blob)` with cleanup via `URL.revokeObjectURL()` in `doLossyCompression`, correct quality parameter to `0.75`, and replace `split(",")` with `slice(indexOf(",") + 1)`.
4. Replace `dataUrl.split(",")` with index-based slicing in `generateClientThumbnail`.
5. Use a static 256-hex table for SHA-256 digest conversion in `hasher` without allocating `Buffer` objects.
6. Allow `createChatAssetNameIndex` to ingest multiple asset collections in a single pass without array concatenation, and replace `toLocaleLowerCase()` with `toLowerCase()`.
7. Remove leftover debug logging in `requestOpenAI`.
