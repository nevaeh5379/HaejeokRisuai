# Native port map

The native port is a replacement frontend, not a WebKit wrapper. The existing
application remains the behavioral reference until each boundary below has a
native implementation and compatibility tests.

## Boundaries

| Existing area | Native destination | Status |
| --- | --- | --- |
| `src/lib/SideBars/Sidebar.svelte` | GTK character and group navigation | List, search, select, create/edit character |
| `src/lib/ChatScreens/DefaultChatScreen.svelte` | GTK message list and composer | Send/stop/continue/regenerate, message edit/delete, image attachment/cleanup, and multi-chat management |
| `src/ts/stores/domain/*` | Rust domain models and repositories | Character/profile/chat/message slice |
| `src/ts/storage/*` | SQLite storage and migration compatibility | Initial repository and safe snapshot import |
| `src/ts/process/index.svelte.ts` | Async Rust chat orchestration | Initial send/stream/persist path |
| `src/ts/process/request/*` | Provider clients and streaming | OpenAI-compatible, Anthropic Messages, and Gemini text protocols with secure settings |
| `src/ts/process/memory/*` | Native memory pipeline | SupaMemory and Hypa V1-V3 core pipelines |
| `src/ts/plugins/*` | Sandboxed plugin compatibility layer | Not started |
| `src/lang/*` | Fluent/gettext-backed localization | Not started |
| Settings, lorebook, character editor | Libadwaita preference/navigation pages | Provider settings, character editor, and character/chat lore read/edit/request pipeline |
| Persona settings and chat binding | GTK persona dialog and prompt context | Catalog load/edit/select, per-chat binding, user substitution, and embedded lore |

## Migration rules

1. User data compatibility is a hard requirement. A native migration must read
   a copied fixture before it is allowed to touch a real RisuAI database.
2. Provider secrets must use the desktop secret service where available and
   must never be written to logs.
3. UI callbacks may mutate presentation state, but storage and provider work
   must live behind explicit Rust traits so it can be tested without GTK.
4. Streaming and other network work must not block the GLib main loop.
5. A boundary is marked complete only after behavior, persistence, error paths,
   and migration/recovery have tests.

## Current storage slice

The GTK app now uses the shared `relational-schema-v3` definition to:

1. initialize a separate native preview database;
2. list characters and all of their conversations;
3. append messages and revision metadata transactionally;
4. continue the final response without discarding unknown message extensions;
5. replace the tail after the last user in one rollback-safe regeneration transaction;
6. edit exact message text while retaining unknown extension nodes;
7. delete one message or a tail while atomically cleaning memory references;
8. reopen without losing messages, including encoded NUL text;
9. reject unknown future schemas without overwriting them.

The `--import-copy` command opens a source database read-only, captures committed
WAL data through SQLite's online backup API, verifies the staged snapshot, and
refuses to overwrite an existing native database. Reading every extension-node
domain into complete Rust models is still pending, so imports should use a
copied source database until broader compatibility coverage is complete.

The shared relational node decoder now reads character `firstMessage`, `desc`,
`personality`, `scenario`, `systemPrompt`, `postHistoryInstructions`,
`exampleMessage`, `creatorNotes`, character lore, per-chat lore, character lore
settings, character `supaMemory`, and per-chat `supaMemoryData`. A virtual first
message is prepended for the native view without writing it back as a normal
chat row. Other extension fields are preserved in SQLite but are not modeled
yet.

Known character profile fields can be edited natively and are committed with
the metadata and revision in one transaction. The updater changes only those
top-level nodes and preserves unknown nested extension data. Multiple chats can
be created, loaded, switched, and permanently deleted. Deleting the final chat
atomically creates a new empty replacement; trash-based chat recovery is not
implemented yet.

Character lore, current-chat lore, and lore scan/budget settings can also be
edited natively. The three related extension subtrees and storage revision are
committed atomically. Unmodeled fields elsewhere in the character/chat object,
inside lore entries, and inside lore settings are retained. Existing ID-less
entries receive stable IDs on their first native save without confusing their
unknown nested data when neighboring entries are deleted.

## Current provider slice

When a saved provider or `RISUAI_PROVIDER_MODEL` is configured, network work runs
on a Tokio runtime and bounded events cross to the GLib main loop. User messages
are committed before the request and all writes remain bound to the original
character/chat IDs even if selection changes while the request is running.
The active preparation or streaming task has an abort handle exposed to the GTK
stop action. Normal and continued generations preserve a nonempty partial on
cancellation or stream failure.

Continue updates the final character row in place and retains its relational
extensions. Regenerate prepares against a cloned history cut at the final user
turn; only a complete nonempty result atomically deletes the old tail and
inserts its replacement. Failure, cancellation, and late SQLite errors keep the
old persisted response. Reroll-history back/forward navigation, automatic
continuation, and alternate response variants are not implemented yet.

Native settings select OpenAI-compatible Chat Completions, Anthropic Messages,
or Gemini `generateContent`, with protocol-specific endpoints, authentication,
request bodies, non-streaming summaries, SSE parsing, errors, and thinking-part
boundaries. Provider type, URL, model, and token limits round-trip through the
relational settings store. Public legacy preset summaries infer the protocol
without reading preset JSON or plaintext keys.

User image inlays retain the compatible `{{inlayed::<UUID>}}` message token and
are stored as private, atomically written PNG files outside SQLite. Import
validates the encoded format, normalizes dimensions to the original
one-megapixel boundary, and enforces per-file, per-message, and per-request
limits. Request conversion emits OpenAI `image_url`, Anthropic image/source
blocks, or Gemini `inlineData`; text-only memory input substitutes `[Image]`.
Missing external assets fail explicitly. Snapshot import intentionally does not
claim to migrate the web IndexedDB inlay store. Orphan cleanup is an explicit,
confirmed action: all message, relational extension, cold archive, preset, and
plugin strings are scanned before files are removed, and unsent composer images
are protected. Automatic deletion on message edit/delete is deliberately
avoided so a transient or future reference cannot destroy an asset.

Native provider settings include maximum context and response tokens. Prompt
token counts include ChatML framing, fixed profile/lore instructions, examples,
depth lore, conversation history, post-history instructions, and the reserved
response. The selected model's tiktoken encoding is used when known, with an
o200k fallback for unknown model IDs. This is currently an estimate rather than
a native Claude/Gemini tokenizer. If the request exceeds
the limit, only the oldest example/greeting/history entries are removed and at
least the newest entry is retained. A fixed prompt plus newest entry that still
does not fit fails locally instead of sending an invalid request. The response
limit is emitted as `max_tokens` for OpenAI/Anthropic and
`generationConfig.maxOutputTokens` for Gemini.

The request assembler includes the supported profile fields, parsed example
messages, virtual greeting, raw conversation text, and active character/current
chat/module lore. Enabled global modules, character modules, current-chat
modules, namespace aliases, and the legacy module-integration list are resolved
in stored module order with duplicate IDs removed. Lore matching covers
always-active, primary/selective and regex
keys, exclusions, per-entry/global scan depth, recursive activation, probability,
priority/token budget, roles, and description/history-depth positions. Token
budgets use the selected model's tiktoken encoding with an o200k fallback.

This is not yet equivalent to RisuAI's production prompt pipeline. Persona
embedded modules, folder/child lore behavior, sticky activation chat variables, lore/preset
injection directives, custom prompt-template positions, full CBS parsing,
complete preset options, other memory algorithms, scripts, audio/video and
generated-image parts, clipboard/drop attachment input, tools, retry policies,
reroll-history navigation, and provider-specific parameters remain to be
ported.

Until those prompt contexts exist, entries using greeting-index, named
injection, custom `pt_*` position, or UI-prompt suppression directives are
omitted instead of being silently sent as ordinary lore. Sticky activation
directives are stripped from prompt text but their cross-request chat-variable
state is not persisted yet.

The native provider dialog stores only the base URL, model, and an opaque
credential reference in SQLite. API keys are stored through `oo7` using Secret
Service or the sandbox secret portal, and are zeroized when temporary copies
leave scope. New credentials are created before the SQLite transaction commits;
the previous credential is removed only after that commit succeeds. Legacy
`bot_presets.data` JSON is deliberately not parsed because it may contain
plaintext keys; only the public summary columns are exposed as model hints.

The relational persona catalog and selected index are loaded without flattening
unknown persona fields. A current-chat `bindedPersona` ID overrides the global
selection. Saving the catalog, selected index, and chat binding is one revision
transaction, and existing embedded-module/icon/future fields survive edits.
The resolved persona name drives `{{user}}`, its prompt is placed after character
description context, and its embedded module lore joins the native selector.
Persona icon rendering and persona-card import/export are not implemented.

## Current memory slice

The first native memory boundary implements SupaMemory and the legacy Hypa mode.
The character-level
enable flag and per-chat checkpoint/summary state round-trip through relational
extension nodes. State uses the compatible `checkpoint-id\nsummary` layout;
restoration retains the checkpoint message itself and discards only messages
before it. Malformed, missing-checkpoint, and `hypa:` states fail explicitly.

When context fitting would remove old prompt entries, the pipeline summarizes
the oldest live conversation in chunks capped at the smaller of one third of
the configured context or 1,200 tokens. At least the newest message remains.
The existing summary and new segment are combined through the selected
provider's non-streaming protocol using the same Secret Service-backed
credential.
The updated summary is injected as protected system context.

The new state and storage revision commit atomically before the main streaming
request starts. A summary-provider or SQLite failure aborts that main request.
Chat switches cannot apply a late in-memory state update to the wrong active
chat, while the repository remains bound to the original character/chat IDs.
The header also exposes a validated raw-state editor for recovery and clearing.

Legacy `hypa:\n[...]` history is decoded without changing its stored entry
shape. The first checkpoint still present in the active chat is restored, its
summary is protected, and unique event chunks are embedded with the configured
model through the compatible provider's `/embeddings` endpoint. The current
retained conversation is used as the query; dot-product ranking selects up to
three relevant events. Verified vectors are cached for the provider lifetime.
Anthropic and Gemini do not yet have an independently configured embedding
provider, so their native formats support SupaMemory but reject Hypa similarity
retrieval explicitly.
New summaries update the compatible Hypa history and follow the same
save-before-stream rule.

HypaMemory V2 additionally decodes the relational per-chat `hypaV2Data` object
and converts the earlier `targetId` representation. Invalid summaries are
removed by their complete message-ID sets. When reserved context is exceeded,
the oldest prefix is summarized in configured chunks while the newest four
messages remain verbatim. Main summaries receive half of the configured memory
budget. Retrieval chunks are ranked across the newest three messages with
scores weighted by recency, then fill the remaining budget. The protected
prompt preserves the existing `<Past Events Summary>` and
`<Past Events Details>` structure.

V2 state and its revision are saved before streaming. Unknown fields at the V2
root and within matched main/detail chunks survive native updates, late failures
roll back, and a JSON editor supports inspection, legacy conversion, recovery,
and clearing. Existing `hypav2`, `hypaAllocatedTokens`, and `hypaChunkSize`
settings seed the native mode and limits.

HypaMemory V3 decodes the compatible per-chat `hypaV3Data` summaries,
message-ID sets, importance flags, categories, tags, metrics, and modal state.
Orphan handling follows the selected preset. Summarization advances in the
configured message batches while reserving the newest query messages and can
use a custom `{{slot}}` prompt. Existing selected V3 presets seed memory,
extra-summarization, recent/similar ratios, batch/query counts, orphan and user
message behavior, similarity correction, chunk separator, and summary prompt.

Important summaries consume budget first. Recent summaries are selected from
newest to oldest, similar summary chunks combine recency-weighted query scores
and child-to-parent reciprocal-rank fusion, and random summaries use the
remaining ratio plus unused recent/similar space. The final selection is sorted
chronologically and emitted in `<Past Events Summary>`. Selection metrics are
stored for the native and legacy editors.

V3 state uses the same save-before-stream transaction contract as V2. Unknown
root, matched summary, category, and metric fields are retained, late revision
failures roll back, and the JSON editor supports inspection, recovery, and
clearing. Persistent cross-process vector caching, other memory algorithms,
separate summary submodels, and legacy per-memory plaintext credentials are not
implemented. Native memory deliberately reuses the secure configured provider
rather than importing those plaintext secrets.

## Current character slice

The sidebar can create a character through a native GTK dialog and the content
header opens native profile, chat-management, and lorebook editors. Character
metadata, supported profile/lore nodes, chats, and storage revisions are
transactionally persisted. Images, alternate greetings, groups, character
trash/recovery, chat trash/recovery, and import/export remain.
