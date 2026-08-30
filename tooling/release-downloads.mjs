import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DOWNLOADS_START = "<!-- release-downloads:start -->";
const DOWNLOADS_END = "<!-- release-downloads:end -->";

const platforms = [
  { label: "macOS", matches: (name) => /\.dmg$/i.test(name) },
  {
    label: "Linux",
    matches: (name) => /\.(?:AppImage|deb|rpm|tar\.zst)$/i.test(name),
  },
  { label: "Android", matches: (name) => /\.apk$/i.test(name) },
  { label: "Windows", matches: (name) => /\.(?:exe|msi)$/i.test(name) },
];

function escapeMarkdownLabel(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

export function formatDownloadSection(assets) {
  const lines = [DOWNLOADS_START, "## Downloads", ""];

  for (const platform of platforms) {
    const downloads = assets
      .filter((asset) => platform.matches(asset.name))
      .sort((left, right) => left.name.localeCompare(right.name));

    if (downloads.length === 0) {
      throw new Error(`No ${platform.label} release download was found`);
    }

    lines.push(`${platform.label}:`);
    for (const asset of downloads) {
      lines.push(
        `- [${escapeMarkdownLabel(asset.name)}](${asset.browser_download_url})`,
      );
    }
    lines.push("");
  }

  lines.push(DOWNLOADS_END);
  return lines.join("\n");
}

export function updateReleaseBody(body, assets) {
  const downloads = formatDownloadSection(assets);
  const start = body.indexOf(DOWNLOADS_START);
  const end = body.indexOf(DOWNLOADS_END);

  if (start !== -1 && end !== -1 && end >= start) {
    const before = body.slice(0, start).trimEnd();
    const after = body.slice(end + DOWNLOADS_END.length).trim();
    return `${before}\n\n${downloads}${after ? `\n\n${after}` : ""}\n`;
  }

  const headingEnd = body.startsWith("## ") ? body.indexOf("\n") : -1;
  if (headingEnd !== -1) {
    const heading = body.slice(0, headingEnd);
    const remainder = body.slice(headingEnd).trim();
    return `${heading}\n\n${downloads}${remainder ? `\n\n${remainder}` : ""}\n`;
  }

  return `${downloads}${body.trim() ? `\n\n${body.trim()}` : ""}\n`;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const [releasePath, outputPath] = process.argv.slice(2);
  if (!releasePath || !outputPath) {
    throw new Error(
      "Usage: node tooling/release-downloads.mjs <release.json> <output.md>",
    );
  }

  const release = JSON.parse(readFileSync(releasePath, "utf8"));
  writeFileSync(outputPath, updateReleaseBody(release.body ?? "", release.assets));
}
