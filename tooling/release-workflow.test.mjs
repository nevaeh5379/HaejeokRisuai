import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/github-actions-builder.yml", import.meta.url),
  "utf8",
);

const releaseStep = workflow.slice(
  workflow.indexOf("      - name: Create or update draft release"),
  workflow.indexOf("\n\n  publish-tauri:"),
);

test("binds every draft release to the requested build tag", () => {
  assert.match(releaseStep, /target_commitish: \$target/);
  assert.match(releaseStep, /\.tag_name == \$tag or \.name == \$tag/);
  assert.match(
    releaseStep,
    /ACTUAL_TAG=.*?if \[ \"\$ACTUAL_TAG\" != \"\$BUILD_TAG\" \]/s,
  );
  assert.match(
    releaseStep,
    /gh api --method PATCH \"repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{RELEASE_ID\}\"/,
  );
  assert.match(releaseStep, /still associated with tag/);
});

test("gives Tauri a deterministic release commit target", () => {
  assert.match(
    workflow,
    /tagName: \$\{\{ needs\.prepare-release\.outputs\.build_tag \}\}\n\s+releaseCommitish: \$\{\{ github\.sha \}\}/,
  );
});
