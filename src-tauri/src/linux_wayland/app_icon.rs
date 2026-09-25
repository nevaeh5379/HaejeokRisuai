//! Portable-build window icon registration.
//!
//! KWin (and most Wayland compositors) resolve a window's titlebar/taskbar
//! icon by looking up a desktop entry named after the window's Wayland
//! app-id. The app-id is derived from the executable name (`haejeok-risuai`
//! for bundled Linux builds, `risuai` for `tauri dev`), so portable launches
//! such as AppImages never match an installed entry and fall back to the
//! generic Wayland icon. This module writes a hidden user-level desktop
//! entry (plus the matching hicolor icon) on first launch so the window icon
//! resolves without installing anything into system directories.
//!
//! `tauri dev` registers its own hidden entry from `tooling/tauri.mjs`
//! (marker `X-HaejeokRisuAI-Dev=true`), so this runtime registration is
//! release-only to avoid two owners fighting over the same file.

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

/// Marker identifying entries owned by this runtime registration. Entries
/// without it are treated as user/system owned and are never modified.
const ENTRY_MARKER: &str = "X-HaejeokRisuAI-Portable=true";

/// Icon name referenced by the desktop entry and installed into the user's
/// hicolor icon theme directory.
const ICON_NAME: &str = "RisuAI";

const ICON_PNG: &[u8] = include_bytes!("../../icons/128x128.png");

/// Registers only from release builds; `tauri dev` installs its own entry
/// from `tooling/tauri.mjs` before the app starts.
pub fn register() {
    if cfg!(debug_assertions) {
        return;
    }

    if let Err(error) = try_register() {
        eprintln!("[Linux Wayland] Portable desktop entry registration failed: {error}");
    }
}

fn try_register() -> Result<(), String> {
    let app_id = wayland_app_id();
    let data_home = xdg_data_home()?;
    let applications_directory = data_home.join("applications");
    let entry_path = applications_directory.join(format!("{app_id}.desktop"));

    // A system entry (deb/rpm install) already provides the icon mapping.
    if system_entry_exists(&app_id) {
        return Ok(());
    }

    // Never overwrite an entry this runtime does not own.
    if entry_path.exists() {
        let owned = fs::read_to_string(&entry_path)
            .map(|content| content.contains(ENTRY_MARKER))
            .unwrap_or(false);
        if !owned {
            return Ok(());
        }
    }

    let entry = desktop_entry(&launch_command(), &app_id);
    let existing = fs::read_to_string(&entry_path).unwrap_or_default();
    if existing != entry {
        fs::create_dir_all(&applications_directory)
            .map_err(|error| format!("Failed to create {applications_directory:?}: {error}"))?;
        fs::write(&entry_path, entry)
            .map_err(|error| format!("Failed to write {entry_path:?}: {error}"))?;
        eprintln!("[Linux Wayland] Registered portable desktop entry: {entry_path:?}");
    }

    install_icon(&data_home)?;
    refresh_kde_cache();
    Ok(())
}

/// The Wayland app-id GTK derives from the executable name.
fn wayland_app_id() -> String {
    env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "risuai".to_string())
}

/// The AppImage runtime exports its own path; use it so the entry survives
/// across AppImage updates that remount to a different temporary directory.
fn launch_command() -> String {
    env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .or_else(|| env::current_exe().ok())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| "risuai".to_string())
}

fn xdg_data_home() -> Result<PathBuf, String> {
    if let Some(home) = env::var_os("XDG_DATA_HOME") {
        if !home.is_empty() {
            return Ok(PathBuf::from(home));
        }
    }

    env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(|home| PathBuf::from(home).join(".local").join("share"))
        .ok_or_else(|| "Neither XDG_DATA_HOME nor HOME is set".to_string())
}

fn system_entry_exists(app_id: &str) -> bool {
    let data_dirs =
        env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
    data_dirs
        .split(':')
        .filter(|directory| !directory.is_empty())
        .any(|directory| {
            !is_bundled_data_dir(
                Path::new(directory),
                env::var_os("APPDIR").as_deref().map(Path::new),
            ) && Path::new(directory)
                .join("applications")
                .join(format!("{app_id}.desktop"))
                .exists()
        })
}

/// The linuxdeploy AppRun hook prepends the AppDir (`$APPDIR/usr/share`) to
/// `XDG_DATA_DIRS`, and the AppImage runtime mounts the bundle under
/// `/tmp/.mount_*`. A desktop entry inside the running bundle is not a system
/// installation and must not suppress the portable registration.
fn is_bundled_data_dir(directory: &Path, appdir: Option<&Path>) -> bool {
    if let Some(appdir) = appdir {
        if directory.starts_with(appdir) {
            return true;
        }
    }
    directory.to_string_lossy().contains("/.mount_")
}

fn desktop_entry(exec: &str, app_id: &str) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=RisuAI\n\
         Exec=\"{exec}\"\n\
         Icon={ICON_NAME}\n\
         Terminal=false\n\
         NoDisplay=true\n\
         StartupWMClass={app_id}\n\
         {ENTRY_MARKER}\n"
    )
}

fn install_icon(data_home: &Path) -> Result<(), String> {
    let icon_path = data_home
        .join("icons")
        .join("hicolor")
        .join("128x128")
        .join("apps")
        .join(format!("{ICON_NAME}.png"));
    if icon_path.exists() {
        return Ok(());
    }

    if let Some(parent) = icon_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {parent:?}: {error}"))?;
    }
    fs::write(&icon_path, ICON_PNG)
        .map_err(|error| format!("Failed to write {icon_path:?}: {error}"))?;
    eprintln!("[Linux Wayland] Installed portable window icon: {icon_path:?}");
    Ok(())
}

fn refresh_kde_cache() {
    let desktop = env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .to_lowercase();
    if !desktop.contains("kde") {
        return;
    }

    for binary in ["kbuildsycoca6", "kbuildsycoca5"] {
        if Command::new(binary).spawn().is_ok() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_entry_is_well_formed() {
        let entry = desktop_entry("/opt/RisuAI.AppImage", "RisuAI");
        assert!(entry.starts_with("[Desktop Entry]\n"));
        assert!(entry.contains("Type=Application\n"));
        assert!(entry.contains("Name=RisuAI\n"));
        assert!(entry.contains("Exec=\"/opt/RisuAI.AppImage\"\n"));
        assert!(entry.contains("Icon=RisuAI\n"));
        assert!(entry.contains("NoDisplay=true\n"));
        assert!(entry.contains("StartupWMClass=RisuAI\n"));
        assert!(entry.contains(ENTRY_MARKER));
        assert!(entry.ends_with('\n'));
    }

    #[test]
    fn marker_is_distinct_from_the_dev_entry_marker() {
        assert!(!ENTRY_MARKER.contains("Dev"));
    }

    #[test]
    fn appimage_mount_paths_are_treated_as_bundled() {
        assert!(is_bundled_data_dir(
            Path::new("/tmp/.mount_RisuAI123/usr/share"),
            None
        ));
        assert!(is_bundled_data_dir(
            Path::new("/opt/RisuAI.AppDir/usr/share"),
            Some(Path::new("/opt/RisuAI.AppDir"))
        ));
        assert!(!is_bundled_data_dir(Path::new("/usr/share"), None));
        assert!(!is_bundled_data_dir(
            Path::new("/usr/share"),
            Some(Path::new("/opt/RisuAI.AppDir"))
        ));
    }
}
