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
    `## b101

Changes since \`b100\`:

### Improve release notes [#42](https://github.com/example/project/pull/42):
- feat: group commits (\`abc1234\`) — Ada
- test: cover direct commits (\`def5678\`) — Grace

### Direct commits:
- chore: emergency metadata fix (\`987fedc\`) — Linus

`,
  );
});

test("uses the first-build introduction when there is no previous tag", () => {
  const notes = formatReleaseNotes({
    buildTag: "b1",
    previousTag: null,
    commits: [],
  });

  assert.equal(notes, "## b1\n\nChanges included in this build:\n\n");
});
