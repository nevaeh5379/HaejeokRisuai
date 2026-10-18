# Issue 319: browser reproduction and regression checks

Run against the real Vite app using Chromium:

```powershell
node node_modules/@playwright/test/cli.js test e2e/translator-deadlock.spec.ts --workers=1 --trace=on
```

The test accepts the terms through the UI, skips onboarding, selects Korean and
DeepL X in Language settings, creates a character through the sidebar, types a
short narrative into its First Message editor, and clicks its translation button.
It does not seed storage, import application internals, change stores directly,
mock network responses, or replace the translation implementation.

Before the fix, the default mode with twelve paragraphs and Legacy Translation
with one paragraph started a real HTTP request. Legacy Translation with twelve
paragraphs, and Legacy Translation plus Combine Translation with one paragraph,
remained pending without a request. The stalled cases were sampled twenty times
over five seconds, and settings remained usable during that observation.

After the fix, all four scenarios must start a real HTTP translation request and
leave the loading state when the request succeeds or its error is handled. The
regression spec asserts those outcomes rather than accepting a stuck translation.
Screenshots, Playwright traces, and `translation-evidence.json` are saved under
each test's `test-results` directory.

The app's logged translation input confirms that the default mode passes the
plain text before Markdown rendering, whereas Legacy Translation passes HTML
with paragraph elements. Twelve visible paragraphs therefore do not imply
twelve translation text nodes in the default configuration.

## Limits of this run

No live DeepLX service was available at `http://localhost:1188`. Browser requests
produced the real connection-refused error. Before the fix, only the two controls
reached that error path; after the fix, all four scenarios reached it and returned
from the loading state. This validates recovery and removal of the pre-request
stall, not successful provider translation. Five seconds of observation alone
does not prove an infinite wait; the original source's circular wait explains
the pre-fix result.

`E2E_DEEPLX_URL` can select an existing unauthenticated real service for another
run. Successful provider translations and HTTP 429 behavior have not been
validated here. Separate translator unit tests cover successful batched output,
separator fallback, chunk boundaries, rejected requests, and three-second slot
reservation using isolated dependencies; these are not live-service E2E claims.
