"""Unit tests for the release downloads section (run: python3 tooling/release_downloads_test.py)."""

import unittest

from release_downloads import format_download_section, update_release_body


def asset(name: str) -> dict:
    return {
        "name": name,
        "browser_download_url": f"https://github.com/example/project/releases/download/b10/{name}",
    }


ASSETS = [
    asset("RisuAI_0.0.10_x64-setup.exe"),
    asset("RisuAI-Android-b10.apk.sha256"),
    asset("RisuAI_0.0.10_amd64.AppImage.sig"),
    asset("RisuAI_0.0.10_aarch64.dmg"),
    asset("RisuAI_0.0.10_amd64.AppImage"),
    asset("RisuAI-Android-b10.apk"),
    asset("RisuAI_0.0.10_amd64.deb"),
    asset("latest.json"),
]


class FormatDownloadSectionTest(unittest.TestCase):
    def test_groups_installable_release_assets_into_platform_download_links(self):
        section = format_download_section(ASSETS)

        self.assertRegex(section, r"macOS:\n- \[RisuAI_0\.0\.10_aarch64\.dmg\]")
        self.assertRegex(
            section,
            r"Linux:\n- \[RisuAI_0\.0\.10_amd64\.AppImage\].*\n- \[RisuAI_0\.0\.10_amd64\.deb\]",
        )
        self.assertRegex(section, r"Android:\n- \[RisuAI-Android-b10\.apk\]")
        self.assertRegex(section, r"Windows:\n- \[RisuAI_0\.0\.10_x64-setup\.exe\]")
        self.assertNotRegex(section, r"sha256|\.sig|latest\.json")

    def test_replaces_an_existing_generated_section_without_duplicating_it(self):
        initial = update_release_body("## b10\n\nChanges", ASSETS)
        updated = update_release_body(initial, ASSETS)

        self.assertEqual(updated, initial)
        self.assertRegex(updated, r"^## b10\n\n<!-- release-downloads:start -->")
        self.assertRegex(updated, r"<!-- release-downloads:end -->\n\nChanges\n$")
        self.assertEqual(updated.count("## Downloads"), 1)

    def test_fails_instead_of_publishing_an_incomplete_platform_list(self):
        with self.assertRaisesRegex(
            ValueError, "No Android release download was found"
        ):
            format_download_section(
                [item for item in ASSETS if not item["name"].endswith(".apk")]
            )


if __name__ == "__main__":
    unittest.main()