//! Keep DMA-BUF acceleration enabled and recover the NVIDIA explicit-sync
//! protocol failure before GTK's Wayland event source calls `_exit(1)`.

use std::{
    ffi::{CStr, OsStr},
    os::unix::process::CommandExt,
    process::Command,
};

use gtk::{glib, prelude::*};
use wayland_backend::protocol::wl_interface;
use wayland_protocols::wp::linux_drm_syncobj::v1::client::wp_linux_drm_syncobj_surface_v1::Error;

const DISABLE_DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
const DISABLE_EXPLICIT_SYNC: &str = "__NV_DISABLE_EXPLICIT_SYNC";
const SYNCOBJ_SURFACE: &[u8] = b"wp_linux_drm_syncobj_surface_v1";

#[link(name = "wayland-client")]
extern "C" {
    fn wl_display_get_error(display: *mut libc::c_void) -> libc::c_int;
    fn wl_display_get_protocol_error(
        display: *mut libc::c_void,
        interface: *mut *const wl_interface,
        object_id: *mut u32,
    ) -> u32;
}

pub fn configure() {
    if std::env::var_os(DISABLE_DMABUF).is_none() {
        std::env::set_var(DISABLE_DMABUF, "0");
    }

    // Respect explicit user overrides. The retry inherits this variable as 1,
    // so it cannot register another recovery handler or loop on failure.
    if std::env::var_os(DISABLE_DMABUF).as_deref() != Some(OsStr::new("0"))
        || std::env::var_os(DISABLE_EXPLICIT_SYNC).is_some()
    {
        return;
    }

    // GTK uses structured logging on current distributions. The writer also
    // receives legacy g_log messages through GLib's default log handler.
    glib::log_set_writer_func(|level, fields| {
        let output = glib::log_writer_default(level, fields);
        if level == glib::LogLevel::Message
            && fields
                .iter()
                .any(|field| field.key() == "GLIB_DOMAIN" && field.value_str() == Some("Gdk"))
            && gtk::is_initialized_main_thread()
            && missing_acquire_point()
        {
            restart_without_explicit_sync();
        }
        output
    });
}

fn is_missing_acquire_point(interface: &[u8], code: u32) -> bool {
    interface == SYNCOBJ_SURFACE && code == Error::NoAcquirePoint as u32
}

fn missing_acquire_point() -> bool {
    let Some(display) = gtk::gdk::Display::default() else {
        return false;
    };
    if display.type_().name() != "GdkWaylandDisplay" {
        return false;
    }

    // SAFETY: GDK invokes this handler synchronously before exiting. Its
    // default display and the borrowed wl_display remain alive throughout
    // these read-only queries; neither connection is dispatched or closed.
    unsafe {
        let native_display =
            gdk_wayland_sys::gdk_wayland_display_get_wl_display(display.as_ptr().cast());
        if native_display.is_null() || wl_display_get_error(native_display.cast()) != libc::EPROTO {
            return false;
        }

        let mut interface = std::ptr::null();
        let mut object_id = 0;
        let code =
            wl_display_get_protocol_error(native_display.cast(), &mut interface, &mut object_id);
        if interface.is_null() || (*interface).name.is_null() {
            return false;
        }
        is_missing_acquire_point(CStr::from_ptr((*interface).name).to_bytes(), code)
    }
}

fn restart_without_explicit_sync() {
    // Use Tauri's AppImage-aware executable path and preserve file-open args.
    let executable = match tauri::process::current_binary(&tauri::Env::default()) {
        Ok(executable) => executable,
        Err(error) => {
            eprintln!(
                "[Linux renderer] Could not locate executable for explicit-sync recovery: {error}"
            );
            return;
        }
    };

    eprintln!(
        "[Linux renderer] Missing explicit-sync acquire point; restarting once with {DISABLE_EXPLICIT_SYNC}=1 (DMA-BUF acceleration remains enabled)"
    );

    // exec replaces this process, keeping the PID, working directory and
    // stdio. Close-on-exec Wayland/DBus connections release the old instance
    // before its replacement initializes GTK and the singleton plugin.
    let error = Command::new(executable)
        .args(std::env::args_os().skip(1))
        .env(DISABLE_EXPLICIT_SYNC, "1")
        .exec();
    eprintln!("[Linux renderer] Explicit-sync recovery failed: {error}");
    // Return to GTK so its original fatal exit still reports failure.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_missing_syncobj_acquire_point_is_recoverable() {
        assert!(is_missing_acquire_point(SYNCOBJ_SURFACE, 4));
        assert!(!is_missing_acquire_point(b"wl_surface", 4));
        assert!(!is_missing_acquire_point(b"zwp_linux_buffer_params_v1", 7));
        assert!(!is_missing_acquire_point(SYNCOBJ_SURFACE, 2));
        assert!(!is_missing_acquire_point(SYNCOBJ_SURFACE, 5));
    }
}
