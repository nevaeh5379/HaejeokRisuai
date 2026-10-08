# ComfyUI workflow export

Source: [Comfy-Org/ComfyUI_frontend](https://github.com/Comfy-Org/ComfyUI_frontend/tree/6b0f2bd013fa16c33932085ba519cf8967b03fa7), version 1.57.0, commit `6b0f2bd013fa16c33932085ba519cf8967b03fa7`.
License: GPL-3.0; the upstream license is retained in `upstream/LICENSE`.

`upstream/src/utils/executionUtil.ts` and `upstream/src/lib/litegraph/src/subgraph/ExecutableNodeDTO.ts` are unchanged copies, including their original imports. The upstream **Export (API)** command calls `exportWorkflow('workflow_api', 'output')`, which calls `app.graphToPrompt()`, which calls this `graphToPrompt()`. Risu calls the same function and uses its `output`.

`upstream.json` records SHA-256 hashes of the complete copied files, normalized to LF so Windows checkout line endings do not change verification. Do not run the project's formatter on these files. The slot-compression functions in `upstream/src/utils/litegraphUtil.ts` and `isValidConnection` in `upstream/connection.ts` are unchanged excerpts; only their surrounding imports/exports are reduced to avoid importing canvas UI code.

`graph.ts` is Risu's headless loader, not a copy of ComfyUI's application. It restores backend widget names/values from `/object_info`, graph links, virtual nodes and subgraph instances for the original exporter. The `compat` directory and the two subgraph type aliases supply the graph interface and store reads expected by the original code. Optional node-pack metadata validation uses a small host adapter instead of adding Zod; prompt serialization and link resolution remain in the upstream files.

The complete ComfyUI UI and third-party frontend extension JavaScript are not loaded. Extensions that need their own widget constructors or `serializeValue` callbacks still need their API export from ComfyUI. Saved JSON alone does not contain those executable callbacks.

The three workflow fixtures are unchanged files from the same revision's `browser_tests/assets`: `default.json`, `subgraphs/link-seed.json` and `subgraphs/nested-subgraph.json`.
