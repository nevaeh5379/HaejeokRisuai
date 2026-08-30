#!/usr/bin/env python3
"""Fill the empty download markers in a GitHub release body with asset links.

Reads a release JSON as returned by ``gh api repos/<owner>/<repo>/releases/<id>``,
replaces the ``<!-- release-downloads:** -->`` marker block left by
``tooling/release_notes.py`` with a per-platform download list, and writes
the final Markdown body.

Usage: python3 tooling/release_downloads.py <release.json> <output.md>
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

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


def format_download_section(assets: list[dict]) -> str:
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
            f"- [{escape_markdown_label(item['name'])}]({item['browser_download_url']})"
            for item in downloads
        )
        lines.append("")

    lines.append(DOWNLOADS_END)
    return "\n".join(lines)


def update_release_body(body: str, assets: list[dict]) -> str:
    """Insert the download section into ``body``, replacing existing markers."""
    downloads = format_download_section(assets)

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
    if len(argv) != 2:
        raise SystemExit(
            "Usage: python3 tooling/release_downloads.py <release.json> <output.md>"
        )

    release_path, output_path = argv
    release = json.loads(Path(release_path).read_text(encoding="utf-8"))
    body = update_release_body(release.get("body") or "", release["assets"])
    Path(output_path).write_text(body, encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1:])