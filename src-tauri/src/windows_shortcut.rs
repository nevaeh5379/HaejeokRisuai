use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub const OPEN_CHAT_FLAG: &str = "--open-chat";
pub const OPEN_CHAT_EVENT: &str = "tauri-open-chat";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatShortcutTarget {
    pub character_id: String,
    pub chat_id: String,
}

#[derive(Default)]
pub struct PendingChatShortcutState(pub Mutex<Option<ChatShortcutTarget>>);

/// Extracts `--open-chat <characterId> <chatId>` (or `--open-chat=<characterId>:<chatId>`)
/// from command-line arguments and returns `(remaining_args, latest_chat_target)`.
pub fn extract_args_and_chat_target<I>(args: I) -> (Vec<String>, Option<ChatShortcutTarget>)
where
    I: IntoIterator<Item = String>,
{
    let mut iter = args.into_iter().peekable();
    let mut remaining = Vec::new();
    let mut target = None;

    while let Some(arg) = iter.next() {
        if arg == OPEN_CHAT_FLAG {
            if let Some(character_id) = iter.next() {
                if let Some(chat_id) = iter.next() {
                    let character_id = character_id.trim().to_string();
                    let chat_id = chat_id.trim().to_string();
                    if !character_id.is_empty() && !chat_id.is_empty() {
                        target = Some(ChatShortcutTarget {
                            character_id,
                            chat_id,
                        });
                    }
                }
            }
            continue;
        }

        if let Some(rest) = arg.strip_prefix("--open-chat=") {
            if let Some((character_id, chat_id)) = rest.split_once(':') {
                let character_id = character_id.trim().to_string();
                let chat_id = chat_id.trim().to_string();
                if !character_id.is_empty() && !chat_id.is_empty() {
                    target = Some(ChatShortcutTarget {
                        character_id,
                        chat_id,
                    });
                }
            }
            continue;
        }

        remaining.push(arg);
    }

    (remaining, target)
}

pub fn handle_chat_shortcut_target(app: &AppHandle, target: ChatShortcutTarget) {
    if let Some(state) = app.try_state::<PendingChatShortcutState>() {
        if let Ok(mut pending) = state.0.lock() {
            *pending = Some(target.clone());
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }

    let _ = app.emit_to("main", OPEN_CHAT_EVENT, &target);
}

#[tauri::command]
pub fn take_pending_chat_shortcut(
    state: tauri::State<'_, PendingChatShortcutState>,
) -> Option<ChatShortcutTarget> {
    state.0.lock().ok().and_then(|mut pending| pending.take())
}

pub fn sanitize_windows_filename_component(input: &str, fallback: &str) -> String {
    let mut cleaned = String::with_capacity(input.len());
    let mut last_was_space = false;

    for ch in input.chars() {
        let is_forbidden = matches!(
            ch,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
        ) || ch.is_control();

        if is_forbidden {
            cleaned.push('_');
            last_was_space = false;
        } else if ch.is_whitespace() {
            if !last_was_space {
                cleaned.push(' ');
                last_was_space = true;
            }
        } else {
            cleaned.push(ch);
            last_was_space = false;
        }
    }

    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']);
    let base = if trimmed.is_empty() { fallback } else { trimmed };

    let mut truncated: String = base.chars().take(60).collect();
    truncated = truncated.trim_end_matches(['.', ' ']).to_string();
    if truncated.is_empty() {
        truncated = fallback.to_string();
    }

    if is_reserved_dos_name(&truncated) {
        format!("_{truncated}")
    } else {
        truncated
    }
}

fn is_reserved_dos_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim();
    matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

pub fn format_shortcut_filename(bot_name: &str, chat_name: &str) -> String {
    let safe_bot = sanitize_windows_filename_component(bot_name, "Character");
    let safe_chat = sanitize_windows_filename_component(chat_name, "Chat");
    let combined = format!("{safe_bot} - {safe_chat}");
    let safe_combined = if is_reserved_dos_name(&combined) {
        format!("_{combined}")
    } else {
        combined
    };
    format!("{safe_combined}.lnk")
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn sanitize_id_for_filename(id: &str) -> String {
    let mut out = String::with_capacity(id.len().min(48));
    for ch in id.chars().take(48) {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "char".to_string()
    } else {
        out
    }
}

fn write_character_ico_file(
    icons_dir: &Path,
    character_id: &str,
    ico_bytes: &[u8],
) -> Result<PathBuf, String> {
    if ico_bytes.len() < 22 || &ico_bytes[0..4] != &[0, 0, 1, 0] {
        return Err("Invalid ICO file payload".to_string());
    }
    std::fs::create_dir_all(icons_dir)
        .map_err(|e| format!("Failed to create shortcut icons directory: {e}"))?;

    let safe_id = sanitize_id_for_filename(character_id);
    let hash = fnv1a_64(ico_bytes);
    let file_name = format!("{safe_id}_{hash:016x}.ico");
    let target_path = icons_dir.join(&file_name);

    let prefix = format!("{safe_id}_");
    if let Ok(entries) = std::fs::read_dir(icons_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with(&prefix)
                && name_str.ends_with(".ico")
                && name_str != file_name
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    if !target_path.is_file() {
        std::fs::write(&target_path, ico_bytes)
            .map_err(|e| format!("Failed to write shortcut icon file: {e}"))?;
    }

    Ok(target_path)
}

#[cfg(target_os = "windows")]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn propvariant_from_bool(val: bool) -> windows::Win32::System::Com::StructuredStorage::PROPVARIANT {
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    let mut pv: PROPVARIANT = unsafe { std::mem::zeroed() };
    unsafe {
        let ptr = &mut pv as *mut PROPVARIANT as *mut u8;
        *(ptr as *mut u16) = 11; // VT_BOOL
        let bool_ptr = ptr.add(8) as *mut i16;
        *bool_ptr = if val { -1 } else { 0 }; // VARIANT_TRUE = -1
    }
    pv
}

#[cfg(target_os = "windows")]
fn propvariant_from_string(
    value: &str,
) -> Option<windows::Win32::System::Com::StructuredStorage::PROPVARIANT> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::UI::Shell::SHStrDupW;

    let wide = wide_null(value);
    unsafe {
        if let Ok(pwstr) = SHStrDupW(PCWSTR(wide.as_ptr())) {
            let mut pv: PROPVARIANT = std::mem::zeroed();
            let ptr = &mut pv as *mut PROPVARIANT as *mut u8;
            *(ptr as *mut u16) = 31; // VT_LPWSTR
            let str_ptr = ptr.add(8) as *mut windows::core::PWSTR;
            *str_ptr = pwstr;
            Some(pv)
        } else {
            None
        }
    }
}

#[cfg(target_os = "windows")]
pub fn create_lnk_file(
    lnk_path: &Path,
    exe_path: &Path,
    arguments: &str,
    description: &str,
    icon_path: Option<&Path>,
    app_user_model_id: Option<&str>,
) -> Result<(), String> {
    use windows::{
        core::{Interface, PCWSTR},
        Win32::{
            Foundation::{PROPERTYKEY, RPC_E_CHANGED_MODE},
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
            },
            System::Com::StructuredStorage::PropVariantClear,
            UI::Shell::{
                PropertiesSystem::IPropertyStore,
                IShellLinkW, SHChangeNotify, ShellLink, SHCNE_CREATE, SHCNF_PATHW,
            },
        },
    };

    const PKEY_APP_USER_MODEL_PREVENT_PINNING: PROPERTYKEY = PROPERTYKEY {
        fmtid: windows::core::GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 9,
    };

    const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
        fmtid: windows::core::GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 5,
    };

    struct ComGuard {
        should_uninit: bool,
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.should_uninit {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let should_uninit = if hr.is_ok() {
            true
        } else if hr == RPC_E_CHANGED_MODE {
            false
        } else {
            return Err(format!("Failed to initialize COM: {hr:?}"));
        };
        let _com_guard = ComGuard { should_uninit };

        let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("Failed to create IShellLinkW: {e}"))?;

        let exe_wide = wide_null(&exe_path.to_string_lossy());
        shell_link
            .SetPath(PCWSTR(exe_wide.as_ptr()))
            .map_err(|e| format!("Failed to set shortcut target path: {e}"))?;

        let args_wide = wide_null(arguments);
        shell_link
            .SetArguments(PCWSTR(args_wide.as_ptr()))
            .map_err(|e| format!("Failed to set shortcut arguments: {e}"))?;

        if let Some(parent) = exe_path.parent() {
            let work_dir_wide = wide_null(&parent.to_string_lossy());
            shell_link
                .SetWorkingDirectory(PCWSTR(work_dir_wide.as_ptr()))
                .map_err(|e| format!("Failed to set shortcut working directory: {e}"))?;
        }

        let desc_wide = wide_null(description);
        let _ = shell_link.SetDescription(PCWSTR(desc_wide.as_ptr()));

        let chosen_icon = icon_path.unwrap_or(exe_path);
        let icon_wide = wide_null(&chosen_icon.to_string_lossy());
        shell_link
            .SetIconLocation(PCWSTR(icon_wide.as_ptr()), 0)
            .map_err(|e| format!("Failed to set shortcut icon location: {e}"))?;

        if let Ok(property_store) = shell_link.cast::<IPropertyStore>() {
            let mut pv_pinning = propvariant_from_bool(true);
            let _ = property_store.SetValue(&PKEY_APP_USER_MODEL_PREVENT_PINNING, &pv_pinning);
            let _ = PropVariantClear(&mut pv_pinning);

            if let Some(app_id) = app_user_model_id {
                if let Some(mut pv_id) = propvariant_from_string(app_id) {
                    let _ = property_store.SetValue(&PKEY_APP_USER_MODEL_ID, &pv_id);
                    let _ = PropVariantClear(&mut pv_id);
                }
            }

            let _ = property_store.Commit();
        }

        let persist_file: IPersistFile = shell_link
            .cast()
            .map_err(|e| format!("Failed to cast IShellLinkW to IPersistFile: {e}"))?;

        let lnk_wide = wide_null(&lnk_path.to_string_lossy());
        persist_file
            .Save(PCWSTR(lnk_wide.as_ptr()), true)
            .map_err(|e| format!("Failed to save .lnk file: {e}"))?;

        SHChangeNotify(
            SHCNE_CREATE,
            SHCNF_PATHW,
            Some(lnk_wide.as_ptr() as _),
            None,
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn create_windows_chat_shortcut(
    app: AppHandle,
    character_id: String,
    chat_id: String,
    bot_name: String,
    chat_name: String,
    icon_ico_bytes: Option<Vec<u8>>,
) -> Result<String, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (
            app,
            character_id,
            chat_id,
            bot_name,
            chat_name,
            icon_ico_bytes,
        );
        Err("Desktop shortcuts are only supported on Windows.".to_string())
    }

    #[cfg(target_os = "windows")]
    {
        let character_id = character_id.trim().to_string();
        let chat_id = chat_id.trim().to_string();
        if character_id.is_empty() || chat_id.is_empty() {
            return Err("Character ID and Chat ID are required.".to_string());
        }

        let desktop_dir = app
            .path()
            .desktop_dir()
            .map_err(|e| format!("Could not resolve Windows Desktop folder: {e}"))?;

        let exe_path = std::env::current_exe()
            .map_err(|e| format!("Could not resolve current executable path: {e}"))?;

        let icon_path = if let Some(ico_bytes) = icon_ico_bytes.as_deref() {
            let app_local_data = app
                .path()
                .app_local_data_dir()
                .or_else(|_| app.path().app_data_dir())
                .map_err(|e| format!("Could not resolve app data folder: {e}"))?;
            let icons_dir = app_local_data.join("shortcut_icons");
            match write_character_ico_file(&icons_dir, &character_id, ico_bytes) {
                Ok(path) => Some(path),
                Err(err) => {
                    eprintln!("[WindowsShortcut] Falling back to default executable icon: {err}");
                    None
                }
            }
        } else {
            None
        };

        let shortcut_filename = format_shortcut_filename(&bot_name, &chat_name);
        let lnk_path = desktop_dir.join(&shortcut_filename);
        let arguments = format!(
            "{OPEN_CHAT_FLAG} \"{}\" \"{}\"",
            character_id.replace('"', ""),
            chat_id.replace('"', "")
        );
        let description = format!(
            "{} - {}",
            if bot_name.trim().is_empty() {
                "Character"
            } else {
                bot_name.trim()
            },
            if chat_name.trim().is_empty() {
                "Chat"
            } else {
                chat_name.trim()
            }
        );

        let shortcut_app_id = format!(
            "{}.shortcut.{}",
            app.config().identifier,
            sanitize_id_for_filename(&character_id)
        );

        create_lnk_file(
            &lnk_path,
            &exe_path,
            &arguments,
            &description,
            icon_path.as_deref(),
            Some(&shortcut_app_id),
        )?;

        Ok(lnk_path.to_string_lossy().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_open_chat_cli_arguments_and_preserves_other_files() {
        let args = vec![
            "C:\\Program Files\\HaejeokRisuai\\HaejeokRisuai.exe".to_string(),
            "--open-chat".to_string(),
            "char-123".to_string(),
            "chat-456".to_string(),
            "C:\\test\\card.png".to_string(),
        ];

        let (remaining, target) = extract_args_and_chat_target(args.into_iter().skip(1));
        assert_eq!(remaining, vec!["C:\\test\\card.png".to_string()]);
        assert_eq!(
            target,
            Some(ChatShortcutTarget {
                character_id: "char-123".to_string(),
                chat_id: "chat-456".to_string(),
            })
        );
    }

    #[test]
    fn sanitizes_shortcut_filename_in_bot_dash_chat_format() {
        assert_eq!(
            format_shortcut_filename("해적봇:시즌2", "Chat 1 / 테스트?"),
            "해적봇_시즌2 - Chat 1 _ 테스트_.lnk"
        );
        assert_eq!(format_shortcut_filename("   ", ""), "Character - Chat.lnk");
        assert_eq!(format_shortcut_filename("CON", "NUL."), "_CON - _NUL.lnk");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn creates_valid_lnk_file_in_temp_dir() {
        let temp = tempfile::tempdir().unwrap();
        let lnk_path = temp.path().join("봇 이름 - 채팅 이름.lnk");
        let exe_path = std::env::current_exe().unwrap();

        create_lnk_file(
            &lnk_path,
            &exe_path,
            "--open-chat \"char-1\" \"chat-2\"",
            "봇 이름 - 채팅 이름",
            None,
            Some("test.shortcut.id"),
        )
        .unwrap();

        assert!(lnk_path.is_file());
        let metadata = std::fs::metadata(&lnk_path).unwrap();
        assert!(metadata.len() > 0);
    }
}
