# Desktop identifier migration

The next desktop release changes `co.aiclient.risu` to
`com.github.nevaeh5379.haejeokrisuai` and sets the bundle publisher to
`nevaeh5379`. Web, Node and Capacitor Android configuration is unchanged.
Do not replace the published 0.0.7538 installer, updater artifacts or winget
manifests. Generate the next version's manifests from its final installers.

## Startup and recovery

`desktop_startup.rs` runs before creating any WebView. Native dialogs wait on
a worker thread so the main event loop remains available. Windows/macOS windows
use their original configuration; Linux keeps its decoration bootstrap and
macOS installs its existing menus after migration.

When the new AppData directory already exists, migration is skipped without
merging. Otherwise, an old AppData directory triggers a three-choice dialog:

- **Move data:** rename all existing old directories to the new identifier.
- **Start fresh:** keep old directories and create the new AppData directory.
- **Cancel/close:** exit without creating the new AppData directory.

Only distinct AppData, AppLocalData and AppConfig paths are moved. On macOS,
`~/Library/WebKit/<identifier>` and `~/Library/Caches/<identifier>` are also
included. A whole directory moves together, including legacy `database.bin`,
SQLite databases/WAL/SHM, images, backups and WebView preferences. Existing
frontend storage initialization handles the legacy database format.

All destinations are checked before moving anything. Exclusive native renames
reject even empty destinations created after that check. Cross-volume failures
are reported; there is no copying or overwriting fallback. Aliased directory
bases are resolved, duplicate pairs are removed, and overlapping or symlinked
app directories are rejected.

An immutable journal is published atomically next to the new AppData directory:
`.com.github.nevaeh5379.haejeokrisuai.migration.json`. A `.pending` sibling is
written and synced before publication; data moves start only after publication.
Removing the journal commits the migration. A process terminated before that
point causes the next launch to restore moved directories in reverse order
before asking again, even if the new AppData directory already exists.
Recovery is itself restartable. Blocked paths do not prevent rollback of other
directories; the journal remains until every path is restored. Invalid journals
and failed recovery stop startup without opening a WebView or database.

The old singleton is acquired during both migration and recovery. Its protocol
matches `tauri-plugin-single-instance` 2.4.4 from
https://github.com/tauri-apps/plugins-workspace (tag `single-instance-v2.4.4`):

| Platform | Reservation |
| --- | --- |
| Windows | `co.aiclient.risu-sim` mutex plus a responsive hidden `-sic` / `-siw` window |
| macOS | `/tmp/co_aiclient_risu_si.sock` Unix listener |
| Linux | `co.aiclient.risu.SingleInstance` session D-Bus name |

If the old app is running, the user must close it and retry, or cancel. Failure
to verify/acquire its singleton fails closed. Do not manually remove the journal
after a failed migration: retain both directory trees and inspect the recorded
pairs first. Normal recovery restores destination-only pairs, leaves
source-only pairs intact, and refuses ambiguous pairs where both/neither exist.

## Windows installation relocation

New current-user installs default to `%LOCALAPPDATA%/Programs/HaejeokRisuai`.
Updates and reinstalls also relocate the old default
`%LOCALAPPDATA%/HaejeokRisuai` to Programs; custom install locations are retained.
Already-relocated installations update in place.

For a relocating `/UPDATE`, the installer remembers the old executable path,
runs the existing uninstaller with `/UPDATE` to preserve app data and shortcuts,
then installs into Programs and refreshes the Windows installation registration.
The old in-place uninstaller is removed after it exits. Only an empty old
installation directory is removed; there is no recursive cleanup of that path.
Existing desktop and start-menu shortcuts are retargeted, including their
working directory and icon, without creating shortcuts that the user removed.
The NSIS bundle compiles locally; a real upgrade still requires verification
in a disposable Windows account or VM.

## Automated verification on Windows

- `cargo test --offline`: 23 tests passed, including directory preservation,
  choices, destination conflicts, rollback, interrupted migration/recovery,
  invalid journals and Windows singleton compatibility/release.
- `cargo check --offline`: passed; existing unused macOS menu-model fields
  produce two warnings on Windows.
- `pnpm check`: passed with zero Svelte errors/warnings.
- A local debug NSIS bundle using the existing `dist/` and a verification-only
  `0.0.7539` override built successfully. Its generated installer sets
  `MANUFACTURER`/installed-app `Publisher` to `nevaeh5379` and `BUNDLEID` to the
  new identifier. This artifact is not a published release and does not replace
  0.0.7538; its version override exists only under ignored `target/`.

## Release verification still required

Use disposable OS accounts or VMs with representative old-version data. Do not
test migration against the developer's real chat storage.

1. On Windows, macOS and Linux, seed old chats, images, backups and persisted
   WebView settings. Confirm the move dialog appears only when new AppData is
   absent. Check all three choices and closing the dialog.
2. Confirm moving preserves chat contents, images and settings; the old folders
   disappear and the old app cannot access the moved data. Relaunch the new app
   and confirm the dialog is skipped.
3. Run the old app before launching the new version. Confirm Retry/Cancel and
   that no storage is created or opened. Launch the old executable while the
   move dialog is open and confirm it cannot acquire the reserved singleton.
4. Confirm Linux decoration preferences are retained, the normal window opens,
   and the macOS window/menu and WebKit preferences behave normally.
5. Upgrade an actual 0.0.7538 Windows NSIS installation with the next installer.
   Confirm its installed-app publisher is `nevaeh5379`, default/custom install
   locations behave as intended, and updater `/UPDATE` preserves old data until
   the app asks for migration. The product name and NSIS uninstall key remain
   `HaejeokRisuai`; changing publisher changes the manufacturer settings key, so
   customized install locations particularly need this real upgrade check.
6. Run Rust checks on macOS and Linux, and build their bundles before release.
   This Windows workspace cannot validate their native runtime behavior.
