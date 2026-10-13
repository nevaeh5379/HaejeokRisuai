// Native regression check for the production plugin. All windows remain hidden
// on about:blank, so this does not load Risu data or alter the user's database.
// Run: cargo run --example macos_wallpaper_smoke [-- dark]
#[cfg(target_os = "macos")]
#[path = "../src/macos_vibrancy.rs"]
mod macos_vibrancy;

#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSBox, NSBoxType,
    NSGlassEffectView, NSGlassEffectViewStyle, NSVisualEffectView, NSWindow,
};
#[cfg(target_os = "macos")]
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
#[cfg(target_os = "macos")]
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
fn main() {
    let dark = std::env::args().any(|arg| arg == "dark");
    let verified = Arc::new(AtomicUsize::new(0));
    let observer = tauri::plugin::Builder::<tauri::Wry, ()>::new("wallpaper-material-smoke")
        .on_window_ready(move |window| {
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
            let views = content.subviews();
            let background = views
                .iter()
                .find(|view| view.downcast_ref::<NSBox>().is_some())
                .expect("missing opaque Desktop Tinting background");
            let background = background.downcast_ref::<NSBox>().unwrap();
            assert!(!background.isTransparent());
            assert_eq!(background.boxType(), NSBoxType::Custom);
            assert_eq!(background.fillColor().alphaComponent(), 1.0);
            let glass = views
                .iter()
                .find(|view| view.downcast_ref::<NSGlassEffectView>().is_some())
                .expect("missing Liquid Glass");
            let glass = glass.downcast_ref::<NSGlassEffectView>().unwrap();
            assert_eq!(glass.style(), NSGlassEffectViewStyle::Regular);
            let popup = window.label().starts_with("sidebar-menu-");
            assert_eq!(glass.cornerRadius(), if popup { 18.0 } else { 0.0 });
            if popup {
                let layer = content.layer().expect("popup must clip its native content");
                assert_eq!(layer.cornerRadius(), 18.0);
                assert!(layer.masksToBounds());
            }
            let background_index = views
                .iter()
                .position(|view| view.downcast_ref::<NSBox>().is_some())
                .unwrap();
            let glass_index = views
                .iter()
                .position(|view| view.downcast_ref::<NSGlassEffectView>().is_some())
                .unwrap();
            assert!(
                background_index < glass_index,
                "opaque Desktop Tinting background must be below glass"
            );
            assert!(
                views
                    .iter()
                    .all(|view| view.downcast_ref::<NSVisualEffectView>().is_none()),
                "Liquid Glass must not have a behind-window vibrancy layer"
            );
            println!(
                "PASS {}: opaque Desktop Tinting background, Regular glass, dark={dark}",
                window.label()
            );
            if verified.fetch_add(1, Ordering::SeqCst) == 2 {
                window.app_handle().exit(0);
            }
        })
        .build();
    tauri::Builder::default()
        .plugin(macos_vibrancy::init())
        .plugin(observer)
        .setup(move |app| {
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
