# RisuAI Native GTK

This directory contains the native GTK 4 port of RisuAI. It is intentionally an
independent Cargo application so the existing Svelte/Tauri application remains
buildable while features are moved over one boundary at a time.

## Requirements

- Rust 1.85 or newer (edition 2024)
- GTK 4
- Libadwaita 1.5 or newer
- `pkg-config` and a C compiler
- A desktop Secret Service implementation such as GNOME Keyring or KWallet

On Arch Linux:

```sh
sudo pacman -Syu --needed base-devel git rustup pkgconf gtk4 libadwaita libsecret sqlite openssl
rustup default stable
rustup component add rustfmt clippy
```

## Run

```sh
cd gtk
cargo run
```

## Import a copied database

Import an existing relational-schema-v3 database before the first normal run:

```sh
cd gtk
cargo run -- --import-copy /path/to/risuai-local.sqlite3
```

The command opens the source read-only and uses SQLite's online backup API, so
committed WAL content is included. It validates both the source and copied
snapshot and refuses to overwrite an existing native database. The original
database is never modified. Until broader compatibility coverage is complete,
use a copied source database rather than the only copy of user data.

## Native provider protocols and secure settings

The native provider boundary supports OpenAI-compatible Chat Completions,
Anthropic Messages, and Google Gemini `generateContent`. All three support
streaming chat and non-streaming memory summaries. Anthropic uses its top-level
system prompt, content blocks, `x-api-key`, and `anthropic-version` contract;
Gemini uses `systemInstruction`, user/model parts, `generationConfig`,
`x-goog-api-key`, and the `streamGenerateContent?alt=sse` endpoint. Thinking
parts are preserved in `<Thoughts>` blocks during normal chat and removed from
memory summaries.

Use the settings button or the model button in the native window to select the
protocol and configure the base URL, model, and API key. Known legacy preset API
types select the corresponding protocol as a convenience. The public protocol,
URL, model, and an opaque credential ID are stored in SQLite. The API key itself
is stored through `oo7`, which uses the desktop Secret Service outside a sandbox
and the secret portal's encrypted file backend inside a sandbox.

Existing RisuAI preset names, API types, and model IDs are offered as public
hints. Their JSON payload is not parsed, so legacy plaintext keys are never
loaded automatically. Base URLs containing user-info, query strings, or
fragments are rejected to prevent credentials from leaking into SQLite.

The following environment variables remain as a fallback when no native
provider setting has been saved:

```sh
export RISUAI_PROVIDER_KIND='openai-compatible' # openai-compatible, anthropic, or gemini
export RISUAI_PROVIDER_MODEL='your-model-id'
export RISUAI_PROVIDER_API_KEY='your-api-key'
export RISUAI_PROVIDER_BASE_URL='https://api.openai.com/v1'
export RISUAI_MAX_CONTEXT_TOKENS='4000'
export RISUAI_MAX_OUTPUT_TOKENS='500'
export RISUAI_MEMORY_MODE='supa' # supa, hypa, hypa-v2, or hypa-v3
export RISUAI_EMBEDDING_MODEL='text-embedding-3-small'
export RISUAI_MEMORY_ALLOCATED_TOKENS='3000'
export RISUAI_MEMORY_CHUNK_TOKENS='3000'
cargo run
```

`RISUAI_OPENAI_MODEL`, `RISUAI_OPENAI_API_KEY`, and
`RISUAI_OPENAI_BASE_URL` remain accepted as legacy aliases. When the base URL is
omitted it defaults to `https://api.openai.com/v1`,
`https://api.anthropic.com/v1`, or
`https://generativelanguage.googleapis.com/v1beta` according to
`RISUAI_PROVIDER_KIND`. The API key may be omitted for a compatible local
server. Environment keys are held in memory and are not copied into native
settings or SQLite.

The native provider dialog also stores maximum context and response tokens.
Before a request, the complete message array and reserved response are counted
with the selected model's tiktoken encoding. Unknown model IDs, including
Anthropic and Gemini IDs, currently use an o200k estimate. Without SupaMemory,
the oldest example, greeting,
and chat entries are removed as needed while fixed profile/lore instructions
and the newest entry remain. With SupaMemory enabled for the character, old
conversation messages are summarized before that lossy trimming occurs. If the
required parts still exceed the limit, the request stops with an explicit local
error. The response limit is mapped to `max_tokens` for OpenAI/Anthropic and
`generationConfig.maxOutputTokens` for Gemini.

The current request sends the selected conversation's text history. Character
description, personality, scenario, system prompt, first message, example
messages, and post-history instructions are read from relational extension
nodes and included in prompt assembly.

The composer exposes native stop, continue, and regenerate actions. Stop aborts
whichever Tokio task currently owns the request, including memory preparation
and the provider stream, without blocking GLib. A partial response from a normal
send or continue request is committed on cancellation or a later stream error;
an empty partial is discarded. Continue appends to the existing final character
message without replacing its unknown relational extension nodes.

Regenerate assembles its prompt with everything after the last user message
temporarily excluded. The existing response remains authoritative in SQLite
until a complete replacement arrives, at which point tail deletion, response
insertion, timestamps, and storage revision commit in one transaction. A
cancelled, failed, empty, or failed-to-save regeneration restores the original
tail. Reroll-history navigation, automatic continuation, and parallel/swipe
response variants remain separate boundaries.

Click a persisted message bubble to edit it, delete only that message, or
delete from that point through the end of the chat. The virtual first greeting
continues to be edited through the character profile. Content edits update only
the message text columns, retaining its ID, role, and unknown relational
extension nodes. Deletion cascades the removed messages' extension rows and
cleans SupaMemory/Hypa V1-V3 references in the same revision transaction; a
late failure rolls all of those changes back together.

Character, current-chat, and selected module lorebooks are decoded from the same
relational nodes. Global enabled modules, character modules, current-chat
modules, namespace aliases, and the legacy integration list are combined in
stored module order and deduplicated by module ID. The native selector supports
always-active, primary/selective and regex
keys, additional/exclusion keys, scan depth, recursive activation, probability,
priority, insertion order, roles, description/history-depth placement, and a
model-aware tiktoken budget. Persona-embedded modules, folder/child behavior,
sticky activation, injection/custom-template positions, and the full CBS parser
still remain. Audio/video attachments, clipboard/drop attachment input, tools,
provider-specific parameters, and preset prompt layouts are also not connected
yet.

The avatar action in the chat header loads the relational `personas` catalog,
lets the user select and edit the active name, model-facing persona description,
and private note, and can bind that persona ID to the current chat. Resolution
matches the original priority: current-chat `bindedPersona`, then global
`selectedPersona`, then the first catalog entry. `{{user}}` substitutions in
character fields, examples, lore, and post-history instructions use the
resolved name; the persona description is inserted as protected system context,
and an embedded persona module contributes its lore. Icon selection/display and
persona card import/export remain separate image boundaries.

Entries that require a greeting index, named preset injection target, custom
prompt-template position, or UI-prompt suppression are currently omitted from
native requests. This is deliberate: treating their control lines as ordinary
lore would leak syntax into the model prompt or place the entry incorrectly.

## Native image attachments

The composer attachment button accepts PNG, JPEG, GIF, and WebP files.
Images are validated by content rather than filename, decoded, resized to at
most one megapixel, and normalized to PNG in
`$XDG_DATA_HOME/risuai-native/inlays`. The directory is private to the user on
Unix, files use UUID names, writes are staged atomically, and paths from message
content are never used directly. A source image is limited to 20 MiB, one
message to eight images, and one provider request to 64 MiB of decoded image
files.

SQLite stores the original compatible `{{inlayed::<UUID>}}` token in message
text. The GTK message bubble resolves that token into an image preview, while
provider requests remove the token and emit OpenAI `image_url`, Anthropic
base64 image blocks, or Gemini `inlineData`. Context fitting reserves vision
tokens, and memory summaries/retrieval text use `[Image]` rather than embedding
UUID markup or base64 data.

The database snapshot importer cannot copy the web application's IndexedDB
inlay store. Imported messages retain their tokens, but a referenced web asset
that is not present in the native inlay directory is reported explicitly.
The clear action beside the attachment button performs an explicit orphan
cleanup. It first scans message text and every relational string-node domain,
plus preserved preset/plugin payloads, then protects those IDs and all currently
pending composer images. Only UUID-named native files with no reference are
deleted, after destructive confirmation. Cleanup refuses to run while an image
import or model request is active.

AVIF, audio, video, generated-image responses, drag-and-drop, clipboard paste,
and image detail controls remain separate boundaries.

## Native SupaMemory and HypaMemory V1-V3

Enable SupaMemory in the character editor. When the assembled prompt would
otherwise discard old context, the native pipeline restores any existing
chat-specific checkpoint, divides the oldest conversation into bounded chunks,
and asks the configured native provider for a compact updated summary. The
request is non-streaming and uses the same Secret Service-backed
credential as normal chat; legacy plaintext memory keys are not loaded.

The stored format remains compatible with the existing SupaMemory boundary:
the first line is the ID of the first retained message and subsequent lines are
the summary. The summary is inserted as a protected system context. A newly
generated checkpoint is committed to the current chat before the main chat
request is sent. If summarization or SQLite persistence fails, the main request
is not sent. Missing checkpoints, malformed state, and `hypa:` state are
reported locally instead of silently dropping history.

The document-save action in the chat header opens the raw state editor for
inspection, recovery, or clearing. It validates the format before committing.
The provider dialog can switch the character memory pipeline from SupaMemory to
legacy HypaMemory and configure an embedding model. Existing global
`hypaMemory` and `hypaModel` settings seed those native options when no native
override exists. Legacy `hypa:\n[...]` snapshots are restored in stored order;
the first checkpoint still present in the chat is selected. Candidate event
summaries and the current retained conversation are embedded through an
OpenAI-compatible base URL's `/embeddings` endpoint and secure credential,
ranked by dot-product, and the top three are inserted as relevant past events.
Valid vectors are cached for the lifetime of the provider so unchanged event
chunks are not requested repeatedly. Native Anthropic and Gemini currently do
not have a separate embedding provider, so choose SupaMemory with those
protocols; Hypa retrieval stops with an explicit local error instead of silently
changing algorithms.

New legacy-Hypa snapshots retain the existing JSON shape and are committed
before the main request just like SupaMemory. Malformed arrays, invalid vectors,
missing checkpoints, and embedding HTTP failures abort locally. HypaMemory V2
uses the separate per-chat `hypaV2Data` object. Native settings expose its
reserved memory budget and summary chunk limit and inherit existing
`hypav2`, `hypaAllocatedTokens`, and `hypaChunkSize` values.

The V2 pipeline converts the old `targetId` layout, removes summaries whose
message IDs no longer exist, resumes after the last summarized message, and
keeps the newest four messages unsummarized. Independent main summaries are
split into retrieval chunks. Main summaries use half of the reserved budget;
the remaining budget is filled by dot-product results aggregated from the
newest three messages with decreasing weights. The emitted protected context
uses the compatible `<Past Events Summary>` and `<Past Events Details>` tags.
Known V2 fields and the storage revision commit atomically while unknown fields
at the V2 object, main-summary, and retrieval-chunk levels are retained.

HypaMemory V3 reads and writes the existing per-chat `hypaV3Data` object. It
removes orphaned summaries unless the selected preset requests preservation,
resumes after the last connected message, and retains the configured number of
newest messages as similarity queries. Overflow is summarized in independently
stored batches; custom summary prompts support `{{slot}}`. Summary categories,
tags, importance, selection metrics, modal settings, and unknown relational
fields survive native updates.

The V3 memory budget is a percentage of the model context. Important summaries
are selected first, then the remaining space is divided among recent, similar,
and random summaries. Similarity ranking splits summaries with the compatible
separator/regular-expression setting, combines recent queries with increasing
recency weights, and applies child-to-parent reciprocal-rank fusion. An optional
summary of the recent queries provides similarity correction. Selected events
are restored chronologically inside the compatible protected
`<Past Events Summary>` element.

The provider dialog exposes the V3 ratios, batch/query counts, orphan and user
message behavior, correction switch, chunk separator, and summary prompt. When
native settings do not exist, `hypaV3`, the selected `hypaV3Presets` entry, and
legacy `hypaV3Settings` seed them. The memory-state header action opens a
validated JSON editor in both V2 and V3 modes and can clear either state. New V3
state and its storage revision commit before the main stream starts; failure
aborts the model request and rolls back atomically.

Persistent cross-process vector caching, alternate memory algorithms, separate
summary submodels, and legacy per-memory plaintext credentials remain separate
porting boundaries. Native memory continues to reuse the secure configured
provider instead of importing plaintext memory keys.

## Native lorebook editing

Use the document-properties action in the chat header to edit character lore,
current-chat lore, token budget, scan depth, recursive scanning, and full-word
matching. Each entry exposes keys, content, insertion order, probability, mode,
and activation switches. Entries can be added or removed.

Saving updates the character lore, current-chat lore, lore settings, and storage
revision in one transaction. Unknown relational fields outside and inside those
entries are retained. Existing entries without IDs are assigned stable native
IDs during their first edit while their original nested extension data remains
associated with the correct entry.

## Native character and chat management

The header's edit action updates the character name, first message,
description, personality, scenario, system prompt, post-history instructions,
example messages, and creator notes in one SQLite transaction. Unknown
extension-node fields remain untouched.

The chat-management action creates and switches between multiple chats. Chat
deletion requires confirmation; deleting the last chat creates a new empty chat
in the same transaction so a character is never left without a writable
conversation. Chat deletion is currently permanent, so trash and recovery are
still part of the remaining port.

## Check

```sh
cd gtk
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

The current milestone provides the native application shell and persists its
preview characters and messages in a separate `risuai-native.sqlite3` database.
It uses the existing `relational-schema-v3` schema, but deliberately does not
open or modify the Tauri application's live database.
