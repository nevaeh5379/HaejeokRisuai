use std::{io, path::Path, ptr};

use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS},
    Globalization::GetUserDefaultUILanguage,
    System::Registry::{
        RegCloseKey, RegGetValueW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, KEY_WOW64_64KEY, REG_SZ, RRF_RT_REG_SZ,
    },
};

const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\HaejeokRisuai";

fn display_name(language: u16) -> &'static str {
    if language & 0x03ff == 0x0012 {
        "해적리스"
    } else {
        "HaejeokRisuai"
    }
}

pub fn current_display_name() -> &'static str {
    // Share the installer's display-language rule, not the formatting locale.
    display_name(unsafe { GetUserDefaultUILanguage() })
}

/// Refresh on launch after Windows language changes, without affecting startup
/// if a registry entry is absent or not writable (e.g. a machine-wide install).
pub fn sync_display_name() {
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    // This is the Windows display language, not the region/formatting locale.
    let language = unsafe { GetUserDefaultUILanguage() };
    for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        if let Err(error) = sync_entry(root, UNINSTALL_KEY, &executable, language) {
            eprintln!("[InstalledAppName] Could not refresh display name: {error}");
        }
    }
}

fn sync_entry(root: HKEY, key_path: &str, executable: &Path, language: u16) -> io::Result<bool> {
    let Some(key) = RegistryKey::open(root, key_path, KEY_QUERY_VALUE)? else {
        return Ok(false);
    };
    let (Some(location), Some(binary_name)) = (
        key.read_string("InstallLocation")?,
        key.read_string("MainBinaryName")?,
    ) else {
        return Ok(false);
    };
    let location = location
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(&location);
    let directory = Path::new(location);
    // Dev/portable copies must not rename another installed copy. Keep the
    // installer's stable key and only touch an entry owning this executable.
    if !directory.join("uninstall.exe").is_file()
        || !same_file(&directory.join(binary_name), executable)
    {
        return Ok(false);
    }
    let desired_name = display_name(language);
    if key.read_string("DisplayName")?.as_deref() == Some(desired_name) {
        return Ok(false);
    }
    let Some(writable_key) = RegistryKey::open(root, key_path, KEY_SET_VALUE)? else {
        return Ok(false);
    };
    writable_key.write_string("DisplayName", desired_name)?;
    Ok(true)
}

fn same_file(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn check_status(status: u32) -> io::Result<()> {
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(status as i32))
    }
}

struct RegistryKey(HKEY);

impl RegistryKey {
    fn open(root: HKEY, path: &str, access: u32) -> io::Result<Option<Self>> {
        let mut key = ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                root,
                wide(path).as_ptr(),
                0,
                access | KEY_WOW64_64KEY,
                &mut key,
            )
        };
        if matches!(status, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
            return Ok(None);
        }
        check_status(status)?;
        Ok(Some(Self(key)))
    }

    fn read_string(&self, name: &str) -> io::Result<Option<String>> {
        let name = wide(name);
        let mut size = 0;
        let status = unsafe {
            RegGetValueW(
                self.0,
                ptr::null(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut size,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        check_status(status)?;
        let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
        let status = unsafe {
            RegGetValueW(
                self.0,
                ptr::null(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        check_status(status)?;
        let length = buffer
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(buffer.len());
        String::from_utf16(&buffer[..length])
            .map(Some)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    fn write_string(&self, name: &str, value: &str) -> io::Result<()> {
        let value = wide(value);
        let status = unsafe {
            RegSetValueExW(
                self.0,
                wide(name).as_ptr(),
                0,
                REG_SZ,
                value.as_ptr().cast(),
                (value.len() * 2) as u32,
            )
        };
        check_status(status)
    }
}

impl Drop for RegistryKey {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::Registry::{RegCreateKeyExW, RegDeleteTreeW};

    struct Installation {
        directory: tempfile::TempDir,
        key_path: String,
        key: RegistryKey,
    }

    impl Installation {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let key_path = format!(
                r"Software\HaejeokRisuaiTests\InstalledAppName\{}",
                directory.path().file_name().unwrap().to_string_lossy()
            );
            let mut key = ptr::null_mut();
            let status = unsafe {
                RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    wide(&key_path).as_ptr(),
                    0,
                    ptr::null(),
                    0,
                    KEY_QUERY_VALUE | KEY_SET_VALUE | KEY_WOW64_64KEY,
                    ptr::null(),
                    &mut key,
                    ptr::null_mut(),
                )
            };
            check_status(status).unwrap();
            let installation = Self {
                directory,
                key_path,
                key: RegistryKey(key),
            };
            std::fs::write(installation.executable(), b"test executable").unwrap();
            std::fs::write(
                installation.directory.path().join("uninstall.exe"),
                b"test uninstaller",
            )
            .unwrap();
            installation
                .key
                .write_string(
                    "InstallLocation",
                    &format!("\"{}\"", installation.directory.path().display()),
                )
                .unwrap();
            installation
                .key
                .write_string("MainBinaryName", "haejeok-risuai.exe")
                .unwrap();
            installation
                .key
                .write_string("DisplayName", "HaejeokRisuai")
                .unwrap();
            installation
                .key
                .write_string("DisplayVersion", "0.0.7544")
                .unwrap();
            installation
        }

        fn executable(&self) -> std::path::PathBuf {
            self.directory.path().join("haejeok-risuai.exe")
        }

        fn sync(&self, executable: &Path, language: u16) -> bool {
            sync_entry(HKEY_CURRENT_USER, &self.key_path, executable, language).unwrap()
        }
    }

    impl Drop for Installation {
        fn drop(&mut self) {
            unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, wide(&self.key_path).as_ptr()) };
        }
    }

    #[test]
    fn follows_display_language_in_both_directions_and_skips_unchanged_names() {
        let installation = Installation::new();
        assert!(installation.sync(&installation.executable(), 0x0412));
        assert_eq!(
            installation
                .key
                .read_string("DisplayName")
                .unwrap()
                .as_deref(),
            Some("해적리스")
        );
        assert!(!installation.sync(&installation.executable(), 0x0412));
        assert!(installation.sync(&installation.executable(), 0x0409));
        assert_eq!(
            installation
                .key
                .read_string("DisplayName")
                .unwrap()
                .as_deref(),
            Some("HaejeokRisuai")
        );
        assert_eq!(
            installation
                .key
                .read_string("DisplayVersion")
                .unwrap()
                .as_deref(),
            Some("0.0.7544")
        );
    }

    #[test]
    fn portable_or_dev_copy_does_not_rename_the_installed_copy() {
        let installation = Installation::new();
        let portable = tempfile::tempdir().unwrap();
        let executable = portable.path().join("haejeok-risuai.exe");
        std::fs::write(&executable, b"portable executable").unwrap();
        assert!(!installation.sync(&executable, 0x0412));
        assert_eq!(
            installation
                .key
                .read_string("DisplayName")
                .unwrap()
                .as_deref(),
            Some("HaejeokRisuai")
        );
    }

    #[test]
    fn missing_installation_is_not_created() {
        let directory = tempfile::tempdir().unwrap();
        let key_path = format!(
            r"Software\HaejeokRisuaiTests\InstalledAppName\{}",
            directory.path().file_name().unwrap().to_string_lossy()
        );
        assert!(!sync_entry(
            HKEY_CURRENT_USER,
            &key_path,
            &directory.path().join("app.exe"),
            0x0412
        )
        .unwrap());
        assert!(
            RegistryKey::open(HKEY_CURRENT_USER, &key_path, KEY_QUERY_VALUE)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn stale_installation_without_an_uninstaller_is_ignored() {
        let installation = Installation::new();
        std::fs::remove_file(installation.directory.path().join("uninstall.exe")).unwrap();
        assert!(!installation.sync(&installation.executable(), 0x0412));
    }
}
