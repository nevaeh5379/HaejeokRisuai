// Native regression check for the production plugin. All windows remain hidden
// on about:blank, so this does not load Risu data or alter the user's database.
// Run: cargo run --example macos_wallpaper_smoke [-- dark]
#[cfg(target_os = "macos")]
#[path = "../src/macos_vibrancy.rs"]
mod macos_vibrancy;

#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSBox,
    NSGlassEffectView, NSGlassEffectViewStyle, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
    NSVisualEffectState, NSVisualEffectView, NSWindow,
};
#[cfg(target_os = "macos")]
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
#[cfg(target_os = "macos")]
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
async fn verify_materials(app: &tauri::AppHandle, native_blur: bool, dark: bool) {
    let app_for_main = app.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        for window in app_for_main.webview_windows().into_values() {
            let native: &NSWindow = unsafe { &*window.ns_window().unwrap().cast() };
            let content = native.contentView().unwrap();
            let views = content.subviews();
            let glass_count = views
                .iter()
                .filter(|view| view.downcast_ref::<NSGlassEffectView>().is_some())
                .count();
            let vibrancy_count = views
                .iter()
                .filter(|view| view.downcast_ref::<NSVisualEffectView>().is_some())
                .count();
            assert_eq!(
                glass_count,
                usize::from(!native_blur),
                "{} glass count",
                window.label()
            );
            assert_eq!(
                vibrancy_count,
                usize::from(native_blur),
                "{} vibrancy count",
                window.label()
            );
            if native_blur {
                let view = views
                    .iter()
                    .find(|view| view.downcast_ref::<NSVisualEffectView>().is_some())
                    .unwrap();
                let view = view.downcast_ref::<NSVisualEffectView>().unwrap();
                assert_eq!(
                    view.material(),
                    if window.label().starts_with("sidebar-menu-") {
                        NSVisualEffectMaterial::Popover
                    } else {
                        NSVisualEffectMaterial::Sidebar
                    }
                );
                assert_eq!(
                    view.blendingMode(),
                    NSVisualEffectBlendingMode::BehindWindow
                );
                assert_eq!(view.state(), NSVisualEffectState::FollowsWindowActiveState);
                let expected = unsafe {
                    if dark {
                        NSAppearanceNameDarkAqua
                    } else {
                        NSAppearanceNameAqua
                    }
                };
                assert_eq!(
                    view.appearance().unwrap().name().to_string(),
                    expected.to_string()
                );
            }
            if window.label().starts_with("sidebar-menu-") {
                let layer = content.layer().unwrap();
                assert_eq!(layer.cornerRadius(), 18.0);
                assert!(layer.masksToBounds());
            }
            println!(
                "PASS {}: native_blur={native_blur}, exactly one material, dark={dark}",
                window.label()
            );
        }
        let _ = sender.send(());
    })
    .unwrap();
    receiver.await.unwrap();
}

#[cfg(target_os = "macos")]
fn main() {
    let dark = std::env::args().any(|arg| arg == "dark");
    let verified = Arc::new(AtomicUsize::new(0));
    let observer = tauri::plugin::Builder::<tauri::Wry, ()>::new("wallpaper-material-smoke")
        .on_window_ready(move |window| {
            if verified.load(Ordering::SeqCst) >= 3 {
                return;
            }
            // Inspect the actual background installed by the production plugin.
            let pointer = window.ns_window().unwrap();
            let native: &NSWindow = unsafe { &*pointer.cast() };
            let expected_appearance = unsafe {
                if dark {
                    NSAppearanceNameDarkAqua
                } else {
                    NSAppearanceNameAqua
                }
            };
            assert_eq!(
                native.appearance().unwrap().name().to_string(),
                expected_appearance.to_string()
            );
            let content = native.contentView().unwrap();
            assert_eq!(
                content.appearance().unwrap().name().to_string(),
                expected_appearance.to_string()
            );
            let views = content.subviews();
            assert!(
                views
                    .iter()
                    .all(|view| view.downcast_ref::<NSBox>().is_none()),
                "behind-window Liquid Glass must not have an opaque NSBox background"
            );
            let glass = views
                .iter()
                .find(|view| view.downcast_ref::<NSGlassEffectView>().is_some())
                .expect("missing Liquid Glass");
            assert_eq!(
                glass.appearance().unwrap().name().to_string(),
                expected_appearance.to_string()
            );
            let glass = glass.downcast_ref::<NSGlassEffectView>().unwrap();
            assert_eq!(glass.style(), NSGlassEffectViewStyle::Regular);
            let popup = window.label().starts_with("sidebar-menu-");
            assert_eq!(glass.cornerRadius(), if popup { 18.0 } else { 0.0 });
            if popup {
                let layer = content.layer().expect("popup must clip its native content");
                assert_eq!(layer.cornerRadius(), 18.0);
                assert!(layer.masksToBounds());
            }
            assert!(
                views
                    .iter()
                    .all(|view| view.downcast_ref::<NSVisualEffectView>().is_none()),
                "Liquid Glass must not have a fallback vibrancy layer"
            );
            println!(
                "PASS {}: behind-window Regular glass, dark={dark}",
                window.label()
            );
            if verified.fetch_add(1, Ordering::SeqCst) == 2 {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    for enabled in [true, false, true, true] {
                        macos_vibrancy::set_native_sidebar_blur(&app, enabled)
                            .await
                            .unwrap();
                        verify_materials(&app, enabled, dark).await;
                    }
                    // Windows created after selecting native blur inherit it.
                    let app_for_new = app.clone();
                    let (sender, receiver) = tokio::sync::oneshot::channel();
                    app.run_on_main_thread(move || {
                        WebviewWindowBuilder::new(
                            &app_for_new,
                            "chat-window-created-after-toggle",
                            WebviewUrl::External("about:blank".parse().unwrap()),
                        )
                        .transparent(true)
                        .visible(false)
                        .build()
                        .unwrap();
                        let _ = sender.send(());
                    })
                    .unwrap();
                    receiver.await.unwrap();
                    verify_materials(&app, true, dark).await;
                    macos_vibrancy::set_native_sidebar_blur(&app, false)
                        .await
                        .unwrap();
                    verify_materials(&app, false, dark).await;
                    app.exit(0);
                });
            }
        })
        .build();
    tauri::Builder::default()
        .plugin(macos_vibrancy::init())
        .plugin(observer)
        .setup(move |app| {
            let watchdog = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                eprintln!("native material smoke timed out");
                watchdog.exit(1);
            });
            macos_vibrancy::set_risu_native_appearance(app.handle(), dark)?;
            for label in [
                "main",
                "chat-window-wallpaper-smoke",
                "sidebar-menu-wallpaper-smoke",
            ] {
                WebviewWindowBuilder::new(app, label, WebviewUrl::External("about:blank".parse()?))
                    .transparent(true)
                    .visible(false)
                    .build()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("native smoke app failed");
}

#[cfg(not(target_os = "macos"))]
fn main() {
    println!("This native material check requires macOS 26 or later.");
}
