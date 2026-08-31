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

const publishStep = workflow.slice(
  workflow.indexOf("      - name: Publish release"),
);

const downloadLinksStep = workflow.slice(
  workflow.indexOf("      - name: Add platform download links to release notes"),
  workflow.indexOf("      - name: Publish release"),
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

test("builds release-note download links with the requested build tag", () => {
  assert.match(
    downloadLinksStep,
    /BUILD_TAG: \$\{\{ needs\.prepare-release\.outputs\.build_tag \}\}/,
  );
  assert.match(
    downloadLinksStep,
    /python3 tooling\/release_downloads\.py release\.json release-body\.md "\$BUILD_TAG"/,
  );
});

test("preserves and verifies the build tag when publishing a release", () => {
  assert.match(
    publishStep,
    /BUILD_TAG: \$\{\{ needs\.prepare-release\.outputs\.build_tag \}\}/,
  );
  assert.match(publishStep, /tag_name: \$tag/);
  assert.match(publishStep, /target_commitish: \$target/);
  assert.match(publishStep, /draft: false/);
  assert.match(publishStep, /make_latest: "true"/);
  assert.match(
    publishStep,
    /ACTUAL_TAG=.*?if \[ "\$ACTUAL_TAG" != "\$BUILD_TAG" \]/s,
  );
  assert.match(publishStep, /Published release .* expected \$\{BUILD_TAG\}/);
});
