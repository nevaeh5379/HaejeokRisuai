//! Directory-only migration: no databases or assets are loaded into memory.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

pub const LEGACY_IDENTIFIER: &str = "co.aiclient.risu";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Move {
    pub source: PathBuf,
    pub destination: PathBuf,
}

pub struct Migration {
    pub data: Move,
    pub paths: Vec<Move>,
    pub journal: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    Migrate,
    Fresh,
    Cancel,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u8,
    moves: Vec<Move>,
}

fn error(message: impl Into<String>) -> io::Error {
    io::Error::other(message.into())
}

// Unlike Path::exists, inaccessible paths and dangling links are not ignored.
fn present(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

fn directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(error(format!(
            "Not a regular directory: {}",
            path.display()
        )));
    }
    Ok(())
}

// Resolve aliases of base directories, including destinations not created yet.
fn resolve(path: &Path) -> io::Result<PathBuf> {
    if present(path)? {
        directory(path)?;
        return fs::canonicalize(path);
    }
    let parent = path
        .parent()
        .ok_or_else(|| error("Directory has no parent"))?;
    let leaf = path
        .file_name()
        .ok_or_else(|| error("Directory has no name"))?;
    Ok(resolve(parent)?.join(leaf))
}

pub fn distinct_paths(paths: Vec<Move>) -> io::Result<Vec<Move>> {
    let mut distinct: Vec<Move> = Vec::new();
    for pair in paths {
        let pair = Move {
            source: resolve(&pair.source)?,
            destination: resolve(&pair.destination)?,
        };
        if pair.source == pair.destination || distinct.contains(&pair) {
            continue;
        }
        for existing in &distinct {
            for left in [&pair.source, &pair.destination] {
                for right in [&existing.source, &existing.destination] {
                    if left.starts_with(right) || right.starts_with(left) {
                        return Err(error("Migration directories overlap"));
                    }
                }
            }
        }
        if pair.source.starts_with(&pair.destination) || pair.destination.starts_with(&pair.source)
        {
            return Err(error("Migration source and destination overlap"));
        }
        distinct.push(pair);
    }
    Ok(distinct)
}

// std::fs::rename replaces an existing destination on Unix. Use the native
// exclusive rename variants so a concurrent destination cannot be overwritten.
fn rename_exclusive(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let source = CString::new(source.as_os_str().as_bytes())?;
        let destination = CString::new(destination.as_os_str().as_bytes())?;
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        let result =
            unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // Do not pass REPLACE_EXISTING or COPY_ALLOWED. Even an empty folder
        // created after preflight must block the move.
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

fn sync_parent(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    File::open(path.parent().ok_or_else(|| error("Path has no parent"))?)?.sync_all()?;
    #[cfg(windows)]
    let _ = path;
    Ok(())
}

fn move_directory(pair: &Move) -> io::Result<()> {
    directory(&pair.source)?;
    if present(&pair.destination)? {
        return Err(error(format!(
            "Destination already exists: {}",
            pair.destination.display()
        )));
    }
    fs::create_dir_all(
        pair.destination
            .parent()
            .ok_or_else(|| error("Missing parent"))?,
    )?;
    rename_exclusive(&pair.source, &pair.destination)?;
    sync_parent(&pair.source)?;
    sync_parent(&pair.destination)
}

impl Migration {
    pub fn needs_prompt(&self) -> io::Result<bool> {
        if present(&self.data.destination)? {
            directory(&self.data.destination)?;
            return Ok(false);
        }
        if present(&self.data.source)? {
            directory(&self.data.source)?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn has_journal(&self) -> io::Result<bool> {
        present(&self.journal)
    }

    fn active_moves(&self) -> io::Result<Vec<Move>> {
        let mut moves = Vec::new();
        // Check every destination, even when its old source is missing.
        for pair in &self.paths {
            if present(&pair.destination)? {
                return Err(error(format!(
                    "Destination already exists: {}",
                    pair.destination.display()
                )));
            }
            if present(&pair.source)? {
                directory(&pair.source)?;
                moves.push(pair.clone());
            }
        }
        Ok(moves)
    }

    fn write_journal(&self, moves: &[Move]) -> io::Result<()> {
        if self.has_journal()? {
            return Err(error("An unfinished migration must be recovered first"));
        }
        let temporary = self.journal.with_extension("pending");
        fs::create_dir_all(
            self.journal
                .parent()
                .ok_or_else(|| error("Missing journal parent"))?,
        )?;
        // A pending file cannot precede any data moves; it is safe to replace.
        if present(&temporary)? {
            fs::remove_file(&temporary)?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        serde_json::to_writer(
            &mut file,
            &Journal {
                version: 1,
                moves: moves.to_vec(),
            },
        )?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        rename_exclusive(&temporary, &self.journal)?;
        sync_parent(&self.journal)
    }

    fn clear_journal(&self) -> io::Result<()> {
        fs::remove_file(&self.journal)?;
        sync_parent(&self.journal)
    }

    /// The journal is immutable until commit. Source/destination presence also
    /// covers termination between a rename and the next instruction.
    pub fn recover(&self) -> io::Result<()> {
        if !self.has_journal()? {
            return Ok(());
        }
        let mut bytes = Vec::new();
        File::open(&self.journal)?
            .take(65537)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 65536 {
            return Err(error("Migration journal is too large"));
        }
        let journal: Journal = serde_json::from_slice(&bytes)?;
        if journal.version != 1 || journal.moves.is_empty() {
            return Err(error("Invalid migration journal"));
        }
        // Never use arbitrary paths from a damaged or edited journal.
        let mut seen = Vec::new();
        for pair in &journal.moves {
            if !self.paths.contains(pair) || seen.contains(pair) {
                return Err(error("Unexpected directory in migration journal"));
            }
            seen.push(pair.clone());
        }
        let mut failures = Vec::new();
        for pair in journal.moves.iter().rev() {
            let result = (|| {
                match (present(&pair.source)?, present(&pair.destination)?) {
                    (true, false) => directory(&pair.source)?,
                    (false, true) => move_directory(&Move {
                        source: pair.destination.clone(),
                        destination: pair.source.clone(),
                    })?,
                    _ => {
                        return Err(error(format!(
                            "Cannot safely recover {} and {}; keep both paths intact and retry",
                            pair.source.display(),
                            pair.destination.display(),
                        )))
                    }
                }
                Ok(())
            })();
            if let Err(e) = result {
                failures.push(e.to_string());
            }
        }
        // A blocked directory must not stop rollback of the other moves.
        // Retain the journal until every directory has been restored.
        if !failures.is_empty() {
            return Err(error(failures.join("; ")));
        }
        self.clear_journal()
    }

    pub fn apply(&self, choice: Choice) -> io::Result<bool> {
        match choice {
            Choice::Cancel => Ok(false),
            Choice::Fresh => {
                fs::create_dir_all(
                    self.data
                        .destination
                        .parent()
                        .ok_or_else(|| error("Missing parent"))?,
                )?;
                fs::create_dir(&self.data.destination)?;
                sync_parent(&self.data.destination)?;
                Ok(true)
            }
            Choice::Migrate => self.migrate_with(move_directory),
        }
    }

    fn migrate_with(&self, mut rename: impl FnMut(&Move) -> io::Result<()>) -> io::Result<bool> {
        let moves = self.active_moves()?;
        if !moves.contains(&self.data) {
            return Err(error("Legacy app data is missing"));
        }
        self.write_journal(&moves)?;
        let result = (|| {
            for pair in &moves {
                rename(pair)?;
            }
            self.clear_journal()
        })();
        if let Err(failure) = result {
            if !self.has_journal()? {
                // Journal removal succeeded but its directory sync failed.
                // Do not claim a rollback after the commit record is gone.
                return Err(error(format!(
                    "Directories were moved, but committing the migration failed: {failure}"
                )));
            }
            if let Err(recovery) = self.recover() {
                return Err(error(format!(
                    "Migration failed: {failure}. Recovery failed: {recovery}. Journal: {}",
                    self.journal.display()
                )));
            }
            return Err(error(format!(
                "Migration failed and was rolled back: {failure}"
            )));
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Migration) {
        let root = tempfile::tempdir().unwrap();
        let paths = distinct_paths(
            ["data", "local", "config"]
                .into_iter()
                .map(|base| Move {
                    source: root.path().join(base).join("old"),
                    destination: root.path().join(base).join("new"),
                })
                .collect(),
        )
        .unwrap();
        let migration = Migration {
            data: paths[0].clone(),
            paths,
            journal: root.path().join("migration.json"),
        };
        for pair in &migration.paths {
            fs::create_dir_all(&pair.source).unwrap();
            fs::write(pair.source.join("settings"), b"original settings").unwrap();
        }
        for file in [
            "database.bin",
            "risuai.db",
            "risuai.db-wal",
            "risuai.db-shm",
            "assets/image.png",
            "backups/backup",
            "EBWebView/Preferences",
        ] {
            let file = migration.data.source.join(file);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, b"preserved").unwrap();
        }
        (root, migration)
    }

    fn assert_original(migration: &Migration) {
        for pair in &migration.paths {
            assert_eq!(
                fs::read(pair.source.join("settings")).unwrap(),
                b"original settings"
            );
            assert!(!pair.destination.exists());
        }
    }

    #[test]
    fn consent_moves_whole_directories_and_does_not_prompt_again() {
        let (_root, migration) = fixture();
        assert!(migration.needs_prompt().unwrap());
        assert!(migration.apply(Choice::Migrate).unwrap());
        assert!(!migration.needs_prompt().unwrap());
        assert!(!migration.has_journal().unwrap());
        for pair in &migration.paths {
            assert!(!pair.source.exists());
            assert_eq!(
                fs::read(pair.destination.join("settings")).unwrap(),
                b"original settings"
            );
        }
        for file in [
            "database.bin",
            "risuai.db",
            "risuai.db-wal",
            "risuai.db-shm",
            "assets/image.png",
            "backups/backup",
            "EBWebView/Preferences",
        ] {
            assert_eq!(
                fs::read(migration.data.destination.join(file)).unwrap(),
                b"preserved"
            );
        }
    }

    #[test]
    fn fresh_preserves_old_data_and_records_the_choice_as_a_new_folder() {
        let (_root, migration) = fixture();
        assert!(migration.apply(Choice::Fresh).unwrap());
        assert!(!migration.needs_prompt().unwrap());
        assert_eq!(
            fs::read_dir(&migration.data.destination).unwrap().count(),
            0
        );
        for pair in &migration.paths {
            assert!(pair.source.join("settings").exists());
        }
        assert!(!migration.has_journal().unwrap());
    }

    #[test]
    fn cancel_and_dialog_close_leave_no_new_storage() {
        let (_root, migration) = fixture();
        assert!(!migration.apply(Choice::Cancel).unwrap());
        assert_original(&migration);
        assert!(migration.needs_prompt().unwrap());
        assert!(!migration.has_journal().unwrap());
    }

    #[test]
    fn existing_new_folder_skips_migration_without_merging() {
        let (_root, migration) = fixture();
        fs::create_dir(&migration.data.destination).unwrap();
        fs::write(migration.data.destination.join("new"), b"new data").unwrap();
        assert!(!migration.needs_prompt().unwrap());
        assert!(migration.data.source.join("settings").exists());
        assert_eq!(
            fs::read(migration.data.destination.join("new")).unwrap(),
            b"new data"
        );
    }

    #[test]
    fn duplicate_and_identical_paths_are_only_processed_once() {
        let (_root, migration) = fixture();
        let mut paths = migration.paths.clone();
        paths.push(paths[0].clone());
        paths.push(Move {
            source: paths[0].source.clone(),
            destination: paths[0].source.clone(),
        });
        assert_eq!(distinct_paths(paths).unwrap(), migration.paths);
    }

    #[test]
    fn overlapping_directories_are_rejected() {
        let (_root, migration) = fixture();
        let mut paths = migration.paths.clone();
        paths.push(Move {
            source: paths[0].source.join("assets"),
            destination: paths[0].destination.join("assets"),
        });
        assert!(distinct_paths(paths).is_err());
    }

    #[test]
    fn all_destinations_are_checked_before_any_move() {
        let (_root, migration) = fixture();
        fs::create_dir(&migration.paths[2].destination).unwrap();
        fs::write(migration.paths[2].destination.join("keep"), b"untouched").unwrap();
        assert!(migration.apply(Choice::Migrate).is_err());
        assert!(migration.data.source.join("settings").exists());
        assert!(!migration.data.destination.exists());
        assert_eq!(
            fs::read(migration.paths[2].destination.join("keep")).unwrap(),
            b"untouched"
        );
        assert!(!migration.has_journal().unwrap());
    }

    #[test]
    fn missing_auxiliary_sources_are_optional_but_destination_conflicts_are_not() {
        let (_root, migration) = fixture();
        fs::remove_dir_all(&migration.paths[2].source).unwrap();
        fs::create_dir(&migration.paths[2].destination).unwrap();
        assert!(migration.apply(Choice::Migrate).is_err());
        fs::remove_dir(&migration.paths[2].destination).unwrap();
        assert!(migration.apply(Choice::Migrate).unwrap());
        assert!(!migration.paths[2].destination.exists());
    }

    #[test]
    fn a_failed_move_rolls_back_completed_moves() {
        let (_root, migration) = fixture();
        let mut count = 0;
        let failure = migration
            .migrate_with(|pair| {
                count += 1;
                if count == 3 {
                    return Err(error("Injected rename failure"));
                }
                move_directory(pair)
            })
            .unwrap_err();
        assert!(failure.to_string().contains("rolled back"));
        assert_original(&migration);
        assert!(!migration.has_journal().unwrap());
    }

    #[test]
    fn restart_recovers_every_possible_interruption_point_and_prompts_again() {
        for completed in 0..=3 {
            let (_root, migration) = fixture();
            let moves = migration.active_moves().unwrap();
            migration.write_journal(&moves).unwrap();
            for pair in moves.iter().take(completed) {
                move_directory(pair).unwrap();
            }
            // Reconstruct the paths just as a new process would.
            let restarted = Migration {
                data: migration.data.clone(),
                paths: distinct_paths(migration.paths.clone()).unwrap(),
                journal: migration.journal.clone(),
            };
            restarted.recover().unwrap();
            assert_original(&restarted);
            assert!(restarted.needs_prompt().unwrap());
            restarted.recover().unwrap();
        }
    }

    #[test]
    fn failed_recovery_keeps_journal_and_data_for_another_attempt() {
        let (_root, migration) = fixture();
        migration
            .write_journal(&migration.active_moves().unwrap())
            .unwrap();
        move_directory(&migration.data).unwrap();
        fs::create_dir(&migration.data.source).unwrap();
        assert!(migration.recover().is_err());
        assert!(migration.has_journal().unwrap());
        assert!(migration.data.destination.join("settings").exists());
        fs::remove_dir(&migration.data.source).unwrap();
        migration.recover().unwrap();
        assert_original(&migration);
    }

    #[test]
    fn recovery_can_itself_be_interrupted_and_restarted() {
        let (_root, migration) = fixture();
        migration
            .write_journal(&migration.active_moves().unwrap())
            .unwrap();
        for pair in &migration.paths {
            move_directory(pair).unwrap();
        }
        let pair = &migration.paths[2];
        move_directory(&Move {
            source: pair.destination.clone(),
            destination: pair.source.clone(),
        })
        .unwrap();
        migration.recover().unwrap();
        assert_original(&migration);
    }

    #[test]
    fn unpublished_journal_does_not_signal_a_started_migration() {
        let (_root, migration) = fixture();
        fs::write(
            migration.journal.with_extension("pending"),
            b"incomplete json",
        )
        .unwrap();
        migration.recover().unwrap();
        assert_original(&migration);
        assert!(migration.apply(Choice::Migrate).unwrap());
    }

    #[test]
    fn malformed_or_unexpected_journal_is_rejected_without_touching_data() {
        let (_root, migration) = fixture();
        fs::write(&migration.journal, b"incomplete json").unwrap();
        assert!(migration.recover().is_err());
        let mut moves = migration.paths.clone();
        moves[0].destination = migration.journal.with_file_name("unrelated");
        fs::write(
            &migration.journal,
            serde_json::to_vec(&Journal { version: 1, moves }).unwrap(),
        )
        .unwrap();
        assert!(migration.recover().is_err());
        assert_original(&migration);
    }

    #[test]
    fn rename_never_overwrites_even_an_empty_destination() {
        let (_root, migration) = fixture();
        fs::create_dir(&migration.data.destination).unwrap();
        assert!(rename_exclusive(&migration.data.source, &migration.data.destination).is_err());
        assert!(migration.data.source.join("settings").exists());
        assert!(migration.data.destination.exists());
    }

    #[test]
    fn destination_created_after_preflight_is_preserved_and_other_moves_roll_back() {
        let (_root, migration) = fixture();
        let mut count = 0;
        assert!(migration
            .migrate_with(|pair| {
                count += 1;
                if count == 3 {
                    fs::create_dir(&pair.destination)?;
                }
                move_directory(pair)
            })
            .is_err());
        assert!(migration.data.source.join("settings").exists());
        assert!(!migration.data.destination.exists());
        assert!(migration.paths[1].source.join("settings").exists());
        assert!(migration.paths[2].destination.exists());
        assert!(migration.has_journal().unwrap());
        fs::remove_dir(&migration.paths[2].destination).unwrap();
        migration.recover().unwrap();
        assert_original(&migration);
    }

    #[test]
    fn no_legacy_data_does_not_prompt_or_create_a_folder() {
        let (_root, migration) = fixture();
        fs::remove_dir_all(&migration.data.source).unwrap();
        assert!(!migration.needs_prompt().unwrap());
        assert!(!migration.data.destination.exists());
    }

    #[test]
    fn a_failure_after_rename_is_also_rolled_back() {
        let (_root, migration) = fixture();
        assert!(migration
            .migrate_with(|pair| {
                move_directory(pair)?;
                Err(error("Injected post-rename sync failure"))
            })
            .is_err());
        assert_original(&migration);
    }
}
