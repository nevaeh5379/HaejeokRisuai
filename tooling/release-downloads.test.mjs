import assert from "node:assert/strict";
import test from "node:test";

import { formatDownloadSection, updateReleaseBody } from "./release-downloads.mjs";

const asset = (name) => ({
  name,
  browser_download_url: `https://github.com/example/project/releases/download/b10/${name}`,
});

const assets = [
  asset("RisuAI_0.0.10_x64-setup.exe"),
  asset("RisuAI-Android-b10.apk.sha256"),
  asset("RisuAI_0.0.10_amd64.AppImage.sig"),
  asset("RisuAI_0.0.10_aarch64.dmg"),
  asset("RisuAI_0.0.10_amd64.AppImage"),
  asset("RisuAI-Android-b10.apk"),
  asset("RisuAI_0.0.10_amd64.deb"),
  asset("latest.json"),
];

test("groups installable release assets into platform download links", () => {
  const section = formatDownloadSection(assets);

  assert.match(section, /macOS:\n- \[RisuAI_0\.0\.10_aarch64\.dmg\]/);
  assert.match(
    section,
    /Linux:\n- \[RisuAI_0\.0\.10_amd64\.AppImage\].*\n- \[RisuAI_0\.0\.10_amd64\.deb\]/,
  );
  assert.match(section, /Android:\n- \[RisuAI-Android-b10\.apk\]/);
  assert.match(section, /Windows:\n- \[RisuAI_0\.0\.10_x64-setup\.exe\]/);
  assert.doesNotMatch(section, /sha256|\.sig|latest\.json/);
});

test("replaces an existing generated section without duplicating it", () => {
  const initial = updateReleaseBody("## b10\n\nChanges", assets);
  const updated = updateReleaseBody(initial, assets);

  assert.equal(updated, initial);
  assert.match(updated, /^## b10\n\n<!-- release-downloads:start -->/);
  assert.match(updated, /<!-- release-downloads:end -->\n\nChanges\n$/);
  assert.equal(updated.match(/## Downloads/g)?.length, 1);
});

test("fails instead of publishing an incomplete platform list", () => {
  assert.throws(
    () =>
      formatDownloadSection(
        assets.filter(({ name }) => !name.endsWith(".apk")),
      ),
    /No Android release download was found/,
  );
});
