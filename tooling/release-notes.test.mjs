import assert from "node:assert/strict";
import test from "node:test";

import { formatReleaseNotes } from "./release-notes.mjs";

test("groups release commits under their pull request", () => {
  const pullRequest = {
    number: 42,
    title: "Improve release notes",
    url: "https://github.com/example/project/pull/42",
  };
  const notes = formatReleaseNotes({
    buildTag: "b101",
    previousTag: "b100",
    repository: "example/project",
    commits: [
      {
        subject: "feat: group commits",
        shortSha: "abc1234",
        author: "Ada",
        pullRequest,
      },
      {
        subject: "test: cover direct commits",
        shortSha: "def5678",
        author: "Grace",
        pullRequest,
      },
      {
        subject: "chore: emergency metadata fix",
        shortSha: "987fedc",
        author: "Linus",
        pullRequest: null,
      },
    ],
  });

  assert.equal(
    notes,
    `Changes since [\`b100\`...\`b101\`](https://github.com/example/project/compare/b100...b101):

<details>
<summary>Improve release notes (<a href="https://github.com/example/project/pull/42">#42</a>)</summary>

- feat: group commits (\`abc1234\`) — Ada
- test: cover direct commits (\`def5678\`) — Grace

</details>

### Direct commits:
- chore: emergency metadata fix (\`987fedc\`) — Linus

<!-- release-downloads:start -->
<!-- release-downloads:end -->
`,
  );
});

test("uses the first-build introduction when there is no previous tag", () => {
  const notes = formatReleaseNotes({
    buildTag: "b1",
    previousTag: null,
    commits: [],
  });

  assert.equal(
    notes,
    "Changes included in this build:\n\n<!-- release-downloads:start -->\n<!-- release-downloads:end -->\n",
  );
});

test("escapes pull request titles inside details summaries", () => {
  const notes = formatReleaseNotes({
    buildTag: "b2",
    previousTag: "b1",
    repository: "example/project",
    commits: [
      {
        subject: "fix: render safely",
        shortSha: "abc1234",
        author: "Ada",
        pullRequest: {
          number: 7,
          title: "Fix <details> & links",
          url: "https://github.com/example/project/pull/7?view=files&tab=all",
        },
      },
    ],
  });

  assert.match(
    notes,
    /<summary>Fix &lt;details&gt; &amp; links \(<a href="https:\/\/github\.com\/example\/project\/pull\/7\?view=files&amp;tab=all">#7<\/a>\)<\/summary>/,
  );
});
