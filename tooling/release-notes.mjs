import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  }).trim();
}

function findPreviousTag(buildTag) {
  for (const pattern of ["b*", "v*"]) {
    const tag = run("git", [
      "tag",
      "--list",
      pattern,
      "--sort=-version:refname",
    ])
      .split("\n")
      .find((candidate) => candidate && candidate !== buildTag);
    if (tag) return tag;
  }
  return null;
}

function readCommits(previousTag) {
  const revision = previousTag ? `${previousTag}..HEAD` : "HEAD";
  const hashes = run("git", [
    "log",
    revision,
    "--no-merges",
    "--reverse",
    "--format=%H",
  ])
    .split("\n")
    .filter(Boolean);

  return hashes.map((sha) => ({
    sha,
    shortSha: run("git", ["show", "-s", "--format=%h", sha]),
    subject: run("git", ["show", "-s", "--format=%s", sha]),
    author: run("git", ["show", "-s", "--format=%an", sha]),
  }));
}

function findPullRequest(commit, { repository, baseBranch }) {
  const response = run("gh", [
    "api",
    "-H",
    "Accept: application/vnd.github+json",
    `repos/${repository}/commits/${commit.sha}/pulls`,
  ]);
  const pullRequests = JSON.parse(response);
  const candidates = pullRequests.filter(
    (pullRequest) =>
      pullRequest.merged_at && pullRequest.base?.ref === baseBranch,
  );

  candidates.sort((left, right) => {
    const leftIsMergeCommit = left.merge_commit_sha === commit.sha ? 1 : 0;
    const rightIsMergeCommit = right.merge_commit_sha === commit.sha ? 1 : 0;
    if (leftIsMergeCommit !== rightIsMergeCommit) {
      return rightIsMergeCommit - leftIsMergeCommit;
    }
    return new Date(right.merged_at) - new Date(left.merged_at);
  });

  const pullRequest = candidates[0];
  if (!pullRequest) return null;
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.html_url,
  };
}

export function formatReleaseNotes({ buildTag, previousTag, commits }) {
  const groups = [];
  const groupsByKey = new Map();

  for (const commit of commits) {
    const key = commit.pullRequest
      ? `pr:${commit.pullRequest.number}`
      : "direct";
    let group = groupsByKey.get(key);
    if (!group) {
      group = { pullRequest: commit.pullRequest, commits: [] };
      groupsByKey.set(key, group);
      groups.push(group);
    }
    group.commits.push(commit);
  }

  const lines = [
    `## ${buildTag}`,
    "",
    previousTag
      ? `Changes since \`${previousTag}\`:`
      : "Changes included in this build:",
    "",
  ];

  for (const group of groups) {
    if (group.pullRequest) {
      const { title, number, url } = group.pullRequest;
      lines.push(`### ${title} [#${number}](${url}):`);
    } else {
      lines.push("### Direct commits:");
    }
    for (const commit of group.commits) {
      lines.push(
        `- ${commit.subject} (\`${commit.shortSha}\`) — ${commit.author}`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export function generateReleaseNotes({
  buildTag,
  repository,
  baseBranch = "main",
  outputPath = "release-notes.md",
}) {
  if (!buildTag) throw new Error("BUILD_TAG is required");
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");

  const previousTag = findPreviousTag(buildTag);
  const commits = readCommits(previousTag).map((commit) => ({
    ...commit,
    pullRequest: findPullRequest(commit, { repository, baseBranch }),
  }));
  const notes = formatReleaseNotes({ buildTag, previousTag, commits });
  writeFileSync(outputPath, notes);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  generateReleaseNotes({
    buildTag: process.env.BUILD_TAG,
    repository: process.env.GITHUB_REPOSITORY,
    baseBranch: process.env.GITHUB_REF_NAME || "main",
  });
}
