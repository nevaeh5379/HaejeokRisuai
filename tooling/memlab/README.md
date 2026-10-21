# MemLab memory checks

These developer tools use MemLab to inspect heap snapshots and detect retained
DOM after a UI interaction. MemLab is a dev dependency and is not imported by the
application. Chromium capture uses the project's existing Playwright installation;
Puppeteer's browser downloader and the unused native `sleep` build are disabled.

## Analyze a saved snapshot

```sh
pnpm install --frozen-lockfile
pnpm memory:analyze /path/to/Heap.heapsnapshot
pnpm memory:analyze /path/to/Heap.heapsnapshot --top 30 --output /tmp/heap-summary.json
```

The command accepts Chrome or Node/V8 `.heapsnapshot` files. It uses MemLab's heap
parser and dominator analysis to write `memlab-results/heap-summary.json` by default:

- Node and edge counts, shallow bytes by node type, and detached node count.
- The largest non-string retainers, with object IDs that can be searched in Chrome
  DevTools. String contents are omitted from this summary.

Retained sizes overlap, so do not add the rows together. Snapshot bytes are not
whole-process RSS: images, GPU allocations, other frames/workers, or a separate
Node backend require their own measurements. A single snapshot shows retention;
it does not establish a leak.

## Run the browser checks

```sh
pnpm exec playwright install chromium
pnpm test:memory

# Alternatively, use a locally installed Chromium binary.
MEMLAB_CHROMIUM=/usr/bin/chromium pnpm test:memory
# Use another local port if 5186 is occupied.
MEMLAB_PORT=5187 pnpm test:memory
```

The dedicated Playwright configuration starts a Vite server on localhost, using
fresh browser contexts and synthetic Web SQLite data. It runs three checks:

1. An intentionally retained detached element must be detected.
2. An element removed without a retained reference must pass.
3. Module settings are opened and closed twice to warm lazy imports/caches, then
   measured through a baseline → open settings → close settings interaction.
   MemLab's default detached-DOM leak filter must find no leak clusters.

This is an initial module-settings lifecycle check, not a detector for every
retained JS object or excessive intentional caches. Additional scenarios should
reproduce a concrete interaction and undo it before the final capture.

The three snapshots use the **same page and CDP session** to preserve object IDs.
Do not reload/navigate between captures. Playwright tracing is disabled because
its DOM snapshot cache itself retains detached elements. Snapshots are written
chunk by chunk instead of being assembled in the Node heap.

Results are saved under `memlab-results/browser/<test-name>/`. Playwright clears
this browser-results subdirectory before each run; standalone analysis reports
outside it are preserved:

- `summary.json`: detected cluster count and GC-collected JS heap bytes at each stage.
- `analysis/data/out/leaks.txt`: retainer traces when leaks are found.
- `baseline.heapsnapshot`, `target.heapsnapshot`, `final.heapsnapshot`: raw captures
  for local investigation. These and the results directory are ignored by Git.

Snapshots and detailed traces can contain application data. The CI workflow runs
only synthetic scenarios and uploads summaries/traces; it does not upload raw
heap snapshots. Local analysis does not send the supplied snapshot to a service.

## CI

`MemLab Memory Checks` runs for changes to the memory tooling, settings UI, domain
stores, dependencies, or Vite configuration. It can also be run from the GitHub
Actions **Run workflow** menu. A detector control failure, browser/capture error,
or detected detached-DOM leak in the module-settings scenario fails the job.

The checks are separate from the normal Playwright suite so regular E2E runs do
not incur heap snapshot and analysis costs.

References: [MemLab's comparison model](https://facebook.github.io/memlab/docs/how-memlab-works/),
[snapshot-file comparison API](https://facebook.github.io/memlab/docs/api/api/src/functions/findLeaksBySnapshotFilePaths/).
