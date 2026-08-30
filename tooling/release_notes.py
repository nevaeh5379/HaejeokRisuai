#!/usr/bin/env python3
"""Generate GitHub release notes for rolling ``bNNNN`` builds.

Collects the commits added since the previous build tag, groups them under
the pull request that merged them, and writes a Markdown changelog. The
download section is emitted as empty markers at the end; the publish job
fills them in via ``tooling/release_downloads.py`` once assets are ready.

Required environment: BUILD_TAG, GITHUB_REPOSITORY, GH_TOKEN (for gh api).
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass

# Must stay in sync with DOWNLOADS_START/DOWNLOADS_END in tooling/release_downloads.py
DOWNLOADS_START = "<!-- release-downloads:start -->"
DOWNLOADS_END = "<!-- release-downloads:end -->"


@dataclass
class PullRequest:
    number: int
    title: str
    url: str


@dataclass
class Commit:
    short_sha: str
    subject: str
    author: str
    sha: str = ""
    pull_request: PullRequest | None = None


def run(*command: str) -> str:
    """Run a command and return its stripped stdout, failing loudly on errors."""
    completed = subprocess.run(command, check=True, stdout=subprocess.PIPE, text=True)
    return completed.stdout.strip()


def find_previous_tag(build_tag: str) -> str | None:
    """Return the newest build or version tag other than the current one."""
    for pattern in ("b*", "v*"):
        tags = run("git", "tag", "--list", pattern, "--sort=-version:refname").splitlines()
        for tag in tags:
            if tag and tag != build_tag:
                return tag
    return None


def read_commits(previous_tag: str | None) -> list[Commit]:
    """Return the commits in ``previous_tag..HEAD``, oldest first, merges excluded."""
    revision = f"{previous_tag}..HEAD" if previous_tag else "HEAD"
    hashes = run(
        "git", "log", revision, "--no-merges", "--reverse", "--format=%H"
    ).splitlines()

    commits = []
    for sha in hashes:
        short_sha, author, subject = run(
            "git", "show", "-s", "--format=%h%x1f%an%x1f%s", sha
        ).split("\x1f", 2)
        commits.append(
            Commit(sha=sha, short_sha=short_sha, subject=subject, author=author)
        )
    return commits


def find_pull_request(
    commit_sha: str, repository: str, base_branch: str
) -> PullRequest | None:
    """Return the PR that merged ``commit_sha`` into ``base_branch``, if any."""
    response = run(
        "gh",
        "api",
        "-H",
        "Accept: application/vnd.github+json",
        f"repos/{repository}/commits/{commit_sha}/pulls",
    )
    pull_requests = json.loads(response)
    candidates = [
        pull_request
        for pull_request in pull_requests
        if pull_request["merged_at"] and pull_request["base"]["ref"] == base_branch
    ]
    if not candidates:
        return None

    # Prefer the merge commit of this exact SHA, otherwise the newest merge.
    candidates.sort(
        key=lambda pr: (pr["merge_commit_sha"] == commit_sha, pr["merged_at"]),
        reverse=True,
    )
    winner = candidates[0]
    return PullRequest(
        number=winner["number"],
        title=winner["title"],
        url=winner["html_url"],
    )


def resolve_pull_requests(
    commits: list[Commit], repository: str, base_branch: str
) -> None:
    """Attach the merged pull request (when known) to each commit in place."""
    for commit in commits:
        commit.pull_request = find_pull_request(commit.sha, repository, base_branch)


def escape_html(value: str) -> str:
    """Escape text for safe embedding in HTML."""
    for character, entity in (
        ("&", "&amp;"),
        ("<", "&lt;"),
        (">", "&gt;"),
        ('"', "&quot;"),
        ("'", "&#39;"),
    ):
        value = value.replace(character, entity)
    return value


def changes_header(
    build_tag: str, previous_tag: str | None, repository: str | None
) -> str:
    """Return the opening line above the changelog groups."""
    if not previous_tag:
        return "Changes included in this build:"
    if repository:
        compare_url = f"https://github.com/{repository}/compare/{previous_tag}...{build_tag}"
        return f"Changes since [`{previous_tag}`...`{build_tag}`]({compare_url}):"
    return f"Changes since `{previous_tag}`:"


def commit_line(commit: Commit) -> str:
    """Render one commit author/subject line."""
    return f"- {commit.subject} (`{commit.short_sha}`) — {commit.author}"


def grouped_commits(commits: list[Commit]) -> list[tuple[PullRequest | None, list[Commit]]]:
    """Group commits by their pull request, keeping first-seen order."""
    groups: dict[int | None, list[Commit]] = {}
    for commit in commits:
        key = commit.pull_request.number if commit.pull_request else None
        groups.setdefault(key, []).append(commit)
    return [(group[0].pull_request, group) for group in groups.values()]


def format_release_notes(
    build_tag: str,
    previous_tag: str | None,
    commits: list[Commit],
    repository: str | None = None,
) -> str:
    """Render the release body: header, PR-grouped changelog, download markers."""
    lines = [changes_header(build_tag, previous_tag, repository), ""]

    for pull_request, group in grouped_commits(commits):
        if pull_request:
            summary = (
                f"{escape_html(pull_request.title)} "
                f'(<a href="{escape_html(pull_request.url)}">#{pull_request.number}</a>)'
            )
            lines.append("<details>")
            lines.append(f"<summary>{summary}</summary>")
            lines.append("")
            lines.extend(commit_line(commit) for commit in group)
            lines.extend(["", "</details>"])
        else:
            lines.append("### Direct commits:")
            lines.extend(commit_line(commit) for commit in group)
        lines.append("")

    lines.extend((DOWNLOADS_START, DOWNLOADS_END))
    return "\n".join(lines) + "\n"


def generate_release_notes(
    build_tag: str,
    repository: str,
    base_branch: str = "main",
    output_path: str = "release-notes.md",
) -> None:
    if not build_tag:
        raise ValueError("BUILD_TAG is required")
    if not repository:
        raise ValueError("GITHUB_REPOSITORY is required")

    previous_tag = find_previous_tag(build_tag)
    commits = read_commits(previous_tag)
    resolve_pull_requests(commits, repository, base_branch)

    notes = format_release_notes(build_tag, previous_tag, commits, repository)
    with open(output_path, "w", encoding="utf-8") as file:
        file.write(notes)


def main() -> None:
    generate_release_notes(
        build_tag=os.environ["BUILD_TAG"],
        repository=os.environ["GITHUB_REPOSITORY"],
        base_branch=os.environ.get("GITHUB_REF_NAME") or "main",
    )


if __name__ == "__main__":
    main()