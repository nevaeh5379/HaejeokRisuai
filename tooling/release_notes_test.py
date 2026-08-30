"""Unit tests for the release notes formatter (run: python3 tooling/release_notes_test.py)."""

import unittest

from release_notes import Commit, PullRequest, format_release_notes


class FormatReleaseNotesTest(unittest.TestCase):
    def test_groups_release_commits_under_their_pull_request(self):
        pull_request = PullRequest(
            number=42,
            title="Improve release notes",
            url="https://github.com/example/project/pull/42",
        )
        notes = format_release_notes(
            build_tag="b101",
            previous_tag="b100",
            repository="example/project",
            commits=[
                Commit(
                    short_sha="abc1234",
                    subject="feat: group commits",
                    author="Ada",
                    pull_request=pull_request,
                ),
                Commit(
                    short_sha="def5678",
                    subject="test: cover direct commits",
                    author="Grace",
                    pull_request=pull_request,
                ),
                Commit(
                    short_sha="987fedc",
                    subject="chore: emergency metadata fix",
                    author="Linus",
                ),
            ],
        )

        self.assertEqual(
            notes,
            "Changes since [`b100`...`b101`](https://github.com/example/project/compare/b100...b101):\n"
            "\n"
            "<details>\n"
            "<summary>Improve release notes (<a href=\"https://github.com/example/project/pull/42\">#42</a>)</summary>\n"
            "\n"
            "- feat: group commits (`abc1234`) — Ada\n"
            "- test: cover direct commits (`def5678`) — Grace\n"
            "\n"
            "</details>\n"
            "\n"
            "### Direct commits:\n"
            "- chore: emergency metadata fix (`987fedc`) — Linus\n"
            "\n"
            "<!-- release-downloads:start -->\n"
            "<!-- release-downloads:end -->\n",
        )

    def test_uses_the_first_build_introduction_when_there_is_no_previous_tag(self):
        notes = format_release_notes(build_tag="b1", previous_tag=None, commits=[])

        self.assertEqual(
            notes,
            "Changes included in this build:\n"
            "\n"
            "<!-- release-downloads:start -->\n"
            "<!-- release-downloads:end -->\n",
        )

    def test_escapes_pull_request_titles_inside_details_summaries(self):
        notes = format_release_notes(
            build_tag="b2",
            previous_tag="b1",
            repository="example/project",
            commits=[
                Commit(
                    short_sha="abc1234",
                    subject="fix: render safely",
                    author="Ada",
                    pull_request=PullRequest(
                        number=7,
                        title="Fix <details> & links",
                        url="https://github.com/example/project/pull/7?view=files&tab=all",
                    ),
                )
            ],
        )

        self.assertIn(
            '<summary>Fix &lt;details&gt; &amp; links (<a href="https://github.com/example/project/pull/7?view=files&amp;tab=all">#7</a>)</summary>',
            notes,
        )


if __name__ == "__main__":
    unittest.main()