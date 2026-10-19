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

pub fn format_shortcut_stem(bot_name: &str, chat_name: &str) -> String {
    let safe_bot = sanitize_windows_filename_component(bot_name, "Character");
    let safe_chat = sanitize_windows_filename_component(chat_name, "Chat");
    let combined = format!("{safe_bot} - {safe_chat}");
    if is_reserved_dos_name(&combined) {
        format!("_{combined}")
    } else {
        combined
    }
}

#[allow(dead_code)]
pub fn format_shortcut_filename(bot_name: &str, chat_name: &str) -> String {
    let stem = format_shortcut_stem(bot_name, chat_name);
    format!("{stem}.lnk")
}

pub fn split_command_line_args(input: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;

    for ch in input.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
            }
            ch if ch.is_whitespace() && !in_quotes => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            _ => {
                current.push(ch);
            }
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

pub fn resolve_shortcut_path<F>(
    desktop_dir: &Path,
    bot_name: &str,
    chat_name: &str,
    character_id: &str,
    chat_id: &str,
    get_target_fn: F,
) -> PathBuf
where
    F: Fn(&Path) -> Option<ChatShortcutTarget>,
{
    let stem = format_shortcut_stem(bot_name, chat_name);
    let target = ChatShortcutTarget {
        character_id: character_id.to_string(),
        chat_id: chat_id.to_string(),
    };

    let mut first_free_path = None;

    for i in 1..=100 {
        let filename = if i == 1 {
            format!("{stem}.lnk")
        } else {
            format!("{stem} ({i}).lnk")
        };
        let path = desktop_dir.join(&filename);
        if path.is_file() {
            if let Some(existing_target) = get_target_fn(&path) {
                if existing_target == target {
                    return path;
                }
            }
        } else if first_free_path.is_none() {
            first_free_path = Some(path);
        }
    }

    if let Some(free_path) = first_free_path {
        return free_path;
    }

    let safe_chat_id = sanitize_id_for_filename(chat_id);
    desktop_dir.join(format!("{stem}_{safe_chat_id}.lnk"))
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
    referenced_icon_names: Option<&std::collections::HashSet<String>>,
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

    if let Some(referenced_set) = referenced_icon_names {
        let prefix = format!("{safe_id}_");
        if let Ok(entries) = std::fs::read_dir(icons_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                let lower_name = name_str.to_ascii_lowercase();
                if name_str.starts_with(&prefix)
                    && lower_name.ends_with(".ico")
                    && name_str != file_name
                {
                    // Preserve icon files that are still referenced by existing shortcuts!
                    if !referenced_set.contains(&lower_name) {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
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
fn find_lnk_files_in_dir(dir: &Path, max_depth: usize, out: &mut Vec<PathBuf>) {
    if max_depth == 0 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();
        if name_str.starts_with('.') || name_str.starts_with('$') {
            continue;
        }

        if path.is_file() {
            if path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("lnk"))
                == Some(true)
            {
                out.push(path);
            }
        } else if path.is_dir() && max_depth > 1 {
            find_lnk_files_in_dir(&path, max_depth - 1, out);
        }
    }
}

#[cfg(target_os = "windows")]
fn get_shortcut_chat_target(lnk_path: &Path) -> Option<ChatShortcutTarget> {
    use windows::{
        core::{Interface, PCWSTR},
        Win32::{
            Foundation::RPC_E_CHANGED_MODE,
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ,
            },
            UI::Shell::{IShellLinkW, ShellLink},
        },
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
            return None;
        };
        let _guard = ComGuard { should_uninit };

        let shell_link: IShellLinkW =
            CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let persist_file: IPersistFile = shell_link.cast().ok()?;
        let lnk_wide = wide_null(&lnk_path.to_string_lossy());
        persist_file
            .Load(PCWSTR(lnk_wide.as_ptr()), STGM_READ)
            .ok()?;

        let mut args_buf = [0u16; 1024];
        shell_link.GetArguments(&mut args_buf).ok()?;

        let len = args_buf
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(args_buf.len());
        if len == 0 {
            return None;
        }

        let raw_args = String::from_utf16_lossy(&args_buf[..len]);
        let tokens = split_command_line_args(&raw_args);
        extract_args_and_chat_target(tokens).1
    }
}

#[cfg(target_os = "windows")]
fn get_shortcut_icon_location(lnk_path: &Path) -> Option<PathBuf> {
    use windows::{
        core::{Interface, PCWSTR},
        Win32::{
            System::Com::{
                CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ,
            },
            UI::Shell::{IShellLinkW, ShellLink},
        },
    };

    unsafe {
        let shell_link: IShellLinkW =
            CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let persist_file: IPersistFile = shell_link.cast().ok()?;
        let lnk_wide = wide_null(&lnk_path.to_string_lossy());
        persist_file
            .Load(PCWSTR(lnk_wide.as_ptr()), STGM_READ)
            .ok()?;

        let mut icon_path_buf = [0u16; 512];
        let mut icon_index = 0i32;
        shell_link
            .GetIconLocation(&mut icon_path_buf, &mut icon_index)
            .ok()?;

        let len = icon_path_buf
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(icon_path_buf.len());
        if len == 0 {
            return None;
        }

        let raw_str = String::from_utf16_lossy(&icon_path_buf[..len]);
        let trimmed = raw_str.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(PathBuf::from(trimmed))
        }
    }
}

#[cfg(target_os = "windows")]
fn collect_referenced_shortcut_icons(
    desktop_dirs: &[PathBuf],
) -> Result<std::collections::HashSet<String>, String> {
    use std::collections::HashSet;
    use windows::Win32::{
        Foundation::RPC_E_CHANGED_MODE,
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
    };

    let mut lnk_files = Vec::new();
    for dir in desktop_dirs {
        find_lnk_files_in_dir(dir, 2, &mut lnk_files);
    }

    if lnk_files.is_empty() {
        return Ok(HashSet::new());
    }

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
            return Err(format!("Failed to initialize COM for reading shortcuts: {hr:?}"));
        };
        let _guard = ComGuard { should_uninit };

        let mut referenced_names = HashSet::new();
        for lnk_path in &lnk_files {
            if let Some(icon_path) = get_shortcut_icon_location(lnk_path) {
                if let Some(file_name) = icon_path.file_name() {
                    referenced_names.insert(file_name.to_string_lossy().to_ascii_lowercase());
                }
            }
        }

        Ok(referenced_names)
    }
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

            let mut scan_dirs = vec![desktop_dir.clone()];
            if let Some(public) = std::env::var_os("PUBLIC") {
                let public_desktop = PathBuf::from(public).join("Desktop");
                if public_desktop.is_dir() {
                    scan_dirs.push(public_desktop);
                }
            }

            let referenced_icons = collect_referenced_shortcut_icons(&scan_dirs).ok();

            match write_character_ico_file(
                &icons_dir,
                &character_id,
                ico_bytes,
                referenced_icons.as_ref(),
            ) {
                Ok(path) => Some(path),
                Err(err) => {
                    eprintln!("[WindowsShortcut] Falling back to default executable icon: {err}");
                    None
                }
            }
        } else {
            None
        };

        let lnk_path = resolve_shortcut_path(
            &desktop_dir,
            &bot_name,
            &chat_name,
            &character_id,
            &chat_id,
            get_shortcut_chat_target,
        );
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

    #[cfg(target_os = "windows")]
    #[test]
    fn reads_shortcut_icon_location_from_lnk_file() {
        let temp = tempfile::tempdir().unwrap();
        let lnk_path = temp.path().join("아이콘테스트.lnk");
        let exe_path = std::env::current_exe().unwrap();
        let dummy_icon_path = temp.path().join("custom_icon.ico");
        std::fs::write(&dummy_icon_path, [0u8; 32]).unwrap();

        create_lnk_file(
            &lnk_path,
            &exe_path,
            "--open-chat \"c1\" \"c2\"",
            "desc",
            Some(&dummy_icon_path),
            None,
        )
        .unwrap();

        let icon_loc = get_shortcut_icon_location(&lnk_path);
        assert_eq!(icon_loc, Some(dummy_icon_path));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reads_shortcut_chat_target_from_lnk_file() {
        let temp = tempfile::tempdir().unwrap();
        let lnk_path = temp.path().join("타겟테스트.lnk");
        let exe_path = std::env::current_exe().unwrap();

        create_lnk_file(
            &lnk_path,
            &exe_path,
            "--open-chat \"char-abc\" \"chat-xyz\"",
            "desc",
            None,
            None,
        )
        .unwrap();

        let target = get_shortcut_chat_target(&lnk_path);
        assert_eq!(
            target,
            Some(ChatShortcutTarget {
                character_id: "char-abc".to_string(),
                chat_id: "chat-xyz".to_string(),
            })
        );
    }

    #[test]
    fn splits_command_line_args_correctly() {
        let parsed = split_command_line_args(
            r#"--open-chat "char 123" "chat 456" --other "quoted arg""#,
        );
        assert_eq!(
            parsed,
            vec![
                "--open-chat".to_string(),
                "char 123".to_string(),
                "chat 456".to_string(),
                "--other".to_string(),
                "quoted arg".to_string(),
            ]
        );
    }

    #[test]
    fn resolves_shortcut_path_without_collision() {
        let temp = tempfile::tempdir().unwrap();
        let path = resolve_shortcut_path(
            temp.path(),
            "Bot",
            "Chat",
            "char-1",
            "chat-1",
            |_| None,
        );
        assert_eq!(path, temp.path().join("Bot - Chat.lnk"));
    }

    #[test]
    fn allows_replacing_existing_shortcut_for_same_target() {
        let temp = tempfile::tempdir().unwrap();
        let primary_path = temp.path().join("Bot - Chat.lnk");
        std::fs::write(&primary_path, b"dummy").unwrap();

        // When existing shortcut points to same target (char-1, chat-1),
        // it must resolve to primary_path so it can be replaced/updated.
        let resolved = resolve_shortcut_path(
            temp.path(),
            "Bot",
            "Chat",
            "char-1",
            "chat-1",
            |p| {
                if p == primary_path {
                    Some(ChatShortcutTarget {
                        character_id: "char-1".to_string(),
                        chat_id: "chat-1".to_string(),
                    })
                } else {
                    None
                }
            },
        );
        assert_eq!(resolved, primary_path);
    }

    #[test]
    fn disambiguates_shortcut_path_with_suffix_on_target_collision() {
        let temp = tempfile::tempdir().unwrap();
        let primary_path = temp.path().join("Bot - Chat.lnk");
        std::fs::write(&primary_path, b"dummy").unwrap();

        // Primary path points to chat-1. Now creating shortcut for chat-2!
        let resolved = resolve_shortcut_path(
            temp.path(),
            "Bot",
            "Chat",
            "char-1",
            "chat-2",
            |p| {
                if p == primary_path {
                    Some(ChatShortcutTarget {
                        character_id: "char-1".to_string(),
                        chat_id: "chat-1".to_string(),
                    })
                } else {
                    None
                }
            },
        );
        // Must disambiguate with suffix (2), NOT overwrite chat-1!
        assert_eq!(resolved, temp.path().join("Bot - Chat (2).lnk"));

        // If chat-2 is already saved at (2), recreating chat-2 must update (2)!
        let second_path = temp.path().join("Bot - Chat (2).lnk");
        std::fs::write(&second_path, b"dummy2").unwrap();

        let resolved_repeat = resolve_shortcut_path(
            temp.path(),
            "Bot",
            "Chat",
            "char-1",
            "chat-2",
            |p| {
                if p == primary_path {
                    Some(ChatShortcutTarget {
                        character_id: "char-1".to_string(),
                        chat_id: "chat-1".to_string(),
                    })
                } else if p == second_path {
                    Some(ChatShortcutTarget {
                        character_id: "char-1".to_string(),
                        chat_id: "chat-2".to_string(),
                    })
                } else {
                    None
                }
            },
        );
        assert_eq!(resolved_repeat, second_path);

        // Third different chat target resolves to (3)
        let resolved_third = resolve_shortcut_path(
            temp.path(),
            "Bot",
            "Chat",
            "char-1",
            "chat-3",
            |p| {
                if p == primary_path {
                    Some(ChatShortcutTarget {
                        character_id: "char-1".to_string(),
                        chat_id: "chat-1".to_string(),
                    })
                } else if p == second_path {
                    Some(ChatShortcutTarget {
                        character_id: "char-1".to_string(),
                        chat_id: "chat-2".to_string(),
                    })
                } else {
                    None
                }
            },
        );
        assert_eq!(resolved_third, temp.path().join("Bot - Chat (3).lnk"));
    }

    #[test]
    fn disambiguates_when_sanitization_results_collide() {
        let temp = tempfile::tempdir().unwrap();
        // "A/B" and "A:B" both sanitize to "A_B - Chat"
        let path_ab = resolve_shortcut_path(
            temp.path(),
            "A/B",
            "Chat",
            "char-slash",
            "chat-1",
            |_| None,
        );
        assert_eq!(path_ab, temp.path().join("A_B - Chat.lnk"));
        std::fs::write(&path_ab, b"dummy").unwrap();

        // Now creating for "A:B", which produces the same stem!
        let path_colon = resolve_shortcut_path(
            temp.path(),
            "A:B",
            "Chat",
            "char-colon",
            "chat-2",
            |p| {
                if p == path_ab {
                    Some(ChatShortcutTarget {
                        character_id: "char-slash".to_string(),
                        chat_id: "chat-1".to_string(),
                    })
                } else {
                    None
                }
            },
        );
        assert_eq!(path_colon, temp.path().join("A_B - Chat (2).lnk"));
    }

    #[test]
    fn preserves_referenced_icon_files_during_cleanup() {
        use std::collections::HashSet;

        let temp = tempfile::tempdir().unwrap();
        let icons_dir = temp.path().join("shortcut_icons");

        // Valid minimal 26-byte ICO payloads
        let dummy_ico1 = &[
            0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 4, 0, 0, 0, 22, 0, 0, 0, 1, 2, 3, 4,
        ];
        let dummy_ico2 = &[
            0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 4, 0, 0, 0, 22, 0, 0, 0, 5, 6, 7, 8,
        ];
        let dummy_ico3 = &[
            0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 4, 0, 0, 0, 22, 0, 0, 0, 9, 10, 11, 12,
        ];

        // 1. Write first icon without referenced set (initial icon for Chat 1)
        let path1 = write_character_ico_file(&icons_dir, "char-123", dummy_ico1, None).unwrap();
        assert!(path1.is_file());

        let name1 = path1
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_ascii_lowercase();

        // 2. Chat 1 shortcut references name1. Avatar is changed, and Chat 2 shortcut is created.
        let mut referenced = HashSet::new();
        referenced.insert(name1.clone());

        let path2 = write_character_ico_file(
            &icons_dir,
            "char-123",
            dummy_ico2,
            Some(&referenced),
        )
        .unwrap();
        assert!(path2.is_file());
        // Crucial requirement: path1 must be preserved because Chat 1 still references it!
        assert!(
            path1.is_file(),
            "Referenced icon file should NOT be deleted during cleanup"
        );

        let name2 = path2
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_ascii_lowercase();

        // 3. User later removed Chat 1 shortcut. Now only Chat 2 (name2) is referenced.
        // A new shortcut with avatar 3 is created.
        let mut referenced_after_removal = HashSet::new();
        referenced_after_removal.insert(name2.clone());

        let path3 = write_character_ico_file(
            &icons_dir,
            "char-123",
            dummy_ico3,
            Some(&referenced_after_removal),
        )
        .unwrap();
        assert!(path3.is_file());
        assert!(path2.is_file(), "Still-referenced icon path2 should be preserved");
        // Unreferenced path1 should now be cleaned up
        assert!(
            !path1.is_file(),
            "Unreferenced icon path1 should be cleaned up"
        );

        // 4. If referenced_set is None (e.g. scanning failed), do not delete any icons
        let dummy_ico4 = &[
            0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 4, 0, 0, 0, 22, 0, 0, 0, 13, 14, 15, 16,
        ];
        let path4 = write_character_ico_file(&icons_dir, "char-123", dummy_ico4, None).unwrap();
        assert!(path4.is_file());
        assert!(path2.is_file(), "Fail-safe: path2 must remain when referenced_set is None");
        assert!(path3.is_file(), "Fail-safe: path3 must remain when referenced_set is None");
    }
}
