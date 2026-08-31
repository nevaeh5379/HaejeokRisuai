#!/usr/bin/env python3
"""Fill the empty download markers in a GitHub release body with asset links.

Reads a release JSON as returned by ``gh api repos/<owner>/<repo>/releases/<id>``,
replaces the ``<!-- release-downloads:** -->`` marker block left by
``tooling/release_notes.py`` with a per-platform download list, and writes
the final Markdown body.

Usage: python3 tooling/release_downloads.py <release.json> <output.md> <tag>
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import quote

# Must stay in sync with DOWNLOADS_START/DOWNLOADS_END in tooling/release_notes.py
DOWNLOADS_START = "<!-- release-downloads:start -->"
DOWNLOADS_END = "<!-- release-downloads:end -->"

# Installable artifacts per platform; other assets (.sig, .sha256,
# latest.json) are intentionally excluded.
PLATFORMS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("macOS", re.compile(r"\.dmg$", re.IGNORECASE)),
    ("Linux", re.compile(r"\.(?:AppImage|deb|rpm|tar\.zst)$", re.IGNORECASE)),
    ("Android", re.compile(r"\.apk$", re.IGNORECASE)),
    ("Windows", re.compile(r"\.(?:exe|msi)$", re.IGNORECASE)),
)


def escape_markdown_label(value: str) -> str:
    """Escape a file name so brackets survive inside a Markdown link label."""
    for character in ("\\", "[", "]"):
        value = value.replace(character, f"\\{character}")
    return value


def tagged_download_url(url: str, tag: str) -> str:
    """Replace the release tag segment without changing the asset path or host."""
    match = re.search(r"/releases/download/[^/]+/", url)
    if match is None:
        raise ValueError(f"Unrecognized GitHub release asset URL: {url}")

    prefix = "/releases/download/"
    return f"{url[:match.start()]}{prefix}{quote(tag, safe='')}/{url[match.end():]}"


def asset_download_url(asset: dict, tag: str | None) -> str:
    """Return an asset URL pinned to ``tag`` when one is supplied."""
    url = asset["browser_download_url"]
    return tagged_download_url(url, tag) if tag else url


def format_download_section(assets: list[dict], tag: str | None = None) -> str:
    """Render the per-platform download block wrapped in the markers."""
    lines = [DOWNLOADS_START, "## Downloads", ""]

    for label, pattern in PLATFORMS:
        downloads = sorted(
            (item for item in assets if pattern.search(item["name"])),
            key=lambda item: (item["name"].lower(), item["name"]),
        )
        if not downloads:
            raise ValueError(f"No {label} release download was found")

        lines.append(f"{label}:")
        lines.extend(
            f"- [{escape_markdown_label(item['name'])}]({asset_download_url(item, tag)})"
            for item in downloads
        )
        lines.append("")

    lines.append(DOWNLOADS_END)
    return "\n".join(lines)


def update_release_body(
    body: str, assets: list[dict], tag: str | None = None
) -> str:
    """Insert the download section into ``body``, replacing existing markers."""
    downloads = format_download_section(assets, tag)

    # Preferred path: markers emitted by tooling/release_notes.py.
    start = body.find(DOWNLOADS_START)
    end = body.find(DOWNLOADS_END)
    if start != -1 and end != -1 and end >= start:
        before = body[:start].rstrip()
        after = body[end + len(DOWNLOADS_END) :].strip()
        return f"{before}\n\n{downloads}" + (f"\n\n{after}" if after else "") + "\n"

    # Fallback for handwritten bodies: right after the first heading.
    heading_end = body.find("\n") if body.startswith("## ") else -1
    if heading_end != -1:
        heading = body[:heading_end]
        remainder = body[heading_end:].strip()
        return (
            f"{heading}\n\n{downloads}" + (f"\n\n{remainder}" if remainder else "") + "\n"
        )

    # Last resort: downloads first, original body after.
    trimmed = body.strip()
    return f"{downloads}" + (f"\n\n{trimmed}" if trimmed else "") + "\n"


def main(argv: list[str]) -> None:
    if len(argv) != 3:
        raise SystemExit(
            "Usage: python3 tooling/release_downloads.py <release.json> <output.md> <tag>"
        )

    release_path, output_path, tag = argv
    release = json.loads(Path(release_path).read_text(encoding="utf-8"))
    body = update_release_body(release.get("body") or "", release["assets"], tag)
    Path(output_path).write_text(body, encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1:])
