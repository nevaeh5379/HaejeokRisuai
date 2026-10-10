use crate::{
    app_data_migration::{distinct_paths, Choice, Migration, Move, LEGACY_IDENTIFIER},
    legacy_instance::{LegacyInstance, LockError},
};
use std::io;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

/// Set paths before constructing the app or initializing any plugins.
/// Keep this out of JSON: the CLI's schema may lag behind the Rust runtime.
pub fn configure_directories<R: tauri::Runtime>(context: &mut tauri::Context<R>) {
    use tauri::utils::config::{AppDirectoriesOverride, AppDirectoryOverrides};
    let local_name = "HaejeokRisuai";
    context.config_mut().app.app_directories_override =
        Some(AppDirectoriesOverride::Directories(AppDirectoryOverrides {
            data: Some("$DATA/HaejeokRisuai".into()),
            config: Some("$CONFIG/HaejeokRisuai".into()),
            local_data: Some(format!("$LOCALDATA/{local_name}").into()),
            cache: Some(format!("$CACHE/{local_name}").into()),
            ..Default::default()
        }));
}

fn migration(app: &AppHandle) -> io::Result<Migration> {
    let path = app.path();
    let local_name = "HaejeokRisuai";
    let directories = [
        (path.data_dir(), path.app_data_dir(), "HaejeokRisuai"),
        (path.local_data_dir(), path.app_local_data_dir(), local_name),
        (path.config_dir(), path.app_config_dir(), "HaejeokRisuai"),
        (path.cache_dir(), path.app_cache_dir(), local_name),
    ];
    let mut paths = Vec::new();
    for (base, destination, name) in directories {
        let base = base.map_err(|e| io::Error::other(e.to_string()))?;
        let destination = destination.map_err(|e| io::Error::other(e.to_string()))?;
        // Sources keep the old identifier; destinations use the product name.
        if destination != base.join(name) {
            return Err(io::Error::other(
                "App directory overrides cannot be migrated automatically",
            ));
        }
        paths.push(Move {
            source: base.join(LEGACY_IDENTIFIER),
            destination,
        });
    }
    #[cfg(target_os = "macos")]
    {
        let home = path
            .home_dir()
            .map_err(|e| io::Error::other(e.to_string()))?;
        // AppCache already covers Library/Caches; WebKit uses the bundle ID.
        for base in [home.join("Library/WebKit")] {
            paths.push(Move {
                source: base.join(LEGACY_IDENTIFIER),
                destination: base.join(&app.config().identifier),
            });
        }
    }
    let data = paths
        .first()
        .ok_or_else(|| io::Error::other("No app data path"))?
        .clone();
    let journal = data
        .destination
        .with_file_name(format!(".{}.migration.json", app.config().identifier,));
    Ok(Migration {
        data,
        paths,
        journal,
    })
}

fn korean() -> bool {
    tauri_plugin_os::locale().is_some_and(|locale| {
        locale
            .split(['-', '_'])
            .next()
            .is_some_and(|lang| lang.eq_ignore_ascii_case("ko"))
    })
}

fn text<'a>(ko: bool, english: &'a str, korean: &'a str) -> &'a str {
    if ko {
        korean
    } else {
        english
    }
}

fn prepare(app: &AppHandle) -> io::Result<bool> {
    let migration = migration(app)?;
    let recovering = migration.has_journal()?;
    if !recovering && !migration.needs_prompt()? {
        return Ok(true);
    }
    // An existing new folder skips unused legacy paths entirely.
    let paths = distinct_paths(migration.paths)?;
    let migration = Migration {
        data: paths
            .first()
            .ok_or_else(|| io::Error::other("No app data path"))?
            .clone(),
        paths,
        journal: migration.journal,
    };
    let ko = korean();
    let _legacy_lock = loop {
        match LegacyInstance::acquire() {
            Ok(lock) => break lock,
            Err(LockError::Running) => {
                let retry = text(ko, "Retry", "재시도");
                let result = app.dialog().message(text(ko,
                    "The previous RisuAI app is running. Close it before moving or recovering its data, then retry.",
                    "기존 RisuAI 앱이 실행 중입니다. 데이터 이전 또는 복구 전에 기존 앱을 종료한 뒤 재시도하세요."))
                    .title("HaejeokRisuai")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom(retry.into(), text(ko, "Cancel", "취소").into()))
                    .blocking_show_with_result();
                if result != MessageDialogResult::Ok
                    && result != MessageDialogResult::Custom(retry.into())
                {
                    return Ok(false);
                }
            }
            Err(LockError::Other(e)) => return Err(e),
        }
    };
    // Recover before checking the new folder: a partial move can create it.
    migration.recover()?;
    if !migration.needs_prompt()? {
        return Ok(true);
    }
    let migrate = text(ko, "Move data", "이전");
    let fresh = text(ko, "Start fresh", "새로 시작");
    let result = app.dialog().message(text(ko,
        "Existing RisuAI data was found. Move chats, images, settings, backups and WebView data to HaejeokRisuai?\n\nThis MOVES the folders. After moving, the old app will no longer have access to this data.\n\nStart fresh keeps the old folders and creates a new empty storage folder. Cancel exits without creating storage.",
        "기존 RisuAI 데이터가 발견되었습니다. 채팅·이미지·설정·백업 및 WebView 데이터를 HaejeokRisuai로 이전할까요?\n\n폴더를 실제로 이동합니다. 이동 후 옛 앱에서는 해당 데이터를 이용할 수 없습니다.\n\n‘새로 시작’은 기존 폴더를 보존하고 새 저장 폴더를 만듭니다. ‘취소’는 저장 폴더를 만들지 않고 종료합니다."))
        .title(text(ko, "Move existing RisuAI data", "기존 RisuAI 데이터 이전"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom(migrate.into(), fresh.into(), text(ko, "Cancel", "취소").into()))
        .blocking_show_with_result();
    let choice = match result {
        MessageDialogResult::Yes => Choice::Migrate,
        MessageDialogResult::No => Choice::Fresh,
        MessageDialogResult::Custom(value) if value == migrate => Choice::Migrate,
        MessageDialogResult::Custom(value) if value == fresh => Choice::Fresh,
        _ => Choice::Cancel,
    };
    migration.apply(choice)
}

pub fn fail(app: &AppHandle, failure: impl std::fmt::Display) {
    eprintln!("[AppDataMigration] {failure}");
    let ko = korean();
    let message = format!("{}\n\n{failure}", text(ko,
        "Startup stopped to protect your data. Close both apps and retry. If recovery still fails, keep the old/new folders and migration journal intact for manual recovery.",
        "데이터 보호를 위해 시작을 중단했습니다. 두 앱을 종료한 뒤 재시도하세요. 복구가 계속 실패하면 기존·새 폴더와 이전 기록을 보존하여 수동 복구하세요."));
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title("HaejeokRisuai")
        .kind(MessageDialogKind::Error)
        .show(move |_| handle.exit(1));
}

/// Setup returns immediately so native dialogs can use the main event loop.
pub fn start(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || match prepare(&handle) {
        Ok(false) => handle.exit(0),
        Err(e) => fail(&handle, e),
        Ok(true) => {
            let ready = handle.clone();
            if let Err(e) = handle.run_on_main_thread(move || {
                if let Err(e) = create_window(&ready) {
                    fail(&ready, e);
                }
            }) {
                fail(&handle, e);
            }
        }
    });
}

fn create_window(app: &AppHandle) -> tauri::Result<()> {
    // HTTP setup creates AppCache/.cookies (AppLocalData on Windows).
    // Initialize it after migration, before the WebView can issue requests.
    app.plugin(tauri_plugin_http::init())?;

    #[cfg(target_os = "linux")]
    crate::linux_wayland::create_main_window(app)?;
    #[cfg(not(target_os = "linux"))]
    {
        let config = app.config().app.windows.first().ok_or_else(|| {
            tauri::Error::Io(io::Error::other("Main window configuration is missing"))
        })?;
        tauri::WebviewWindowBuilder::from_config(app, config)?.build()?;
    }
    #[cfg(target_os = "macos")]
    crate::install_haejeok_app_menu(app)?;
    Ok(())
}
