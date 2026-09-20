use gtk::prelude::*;

use super::LinuxWindowDecoration;

pub fn tauri_decorations_enabled(decoration: LinuxWindowDecoration) -> bool {
    decoration == LinuxWindowDecoration::Ssd
}

pub fn mode_for_window(window: &gtk::ApplicationWindow) -> LinuxWindowDecoration {
    if window.is_decorated() {
        LinuxWindowDecoration::Ssd
    } else {
        LinuxWindowDecoration::Csd
    }
}

pub fn prepare_server_side_decoration(
    window: &gtk::ApplicationWindow,
    requested: LinuxWindowDecoration,
    server_side_supported: bool,
) -> bool {
    if requested != LinuxWindowDecoration::Ssd || !server_side_supported || window.is_realized() {
        return false;
    }

    // Tao installs a GtkHeaderBar for decorated Wayland windows. Removing that
    // custom titlebar before realization lets GTK/KWin negotiate compositor
    // decorations through KDE's server-decoration protocol.
    window.set_titlebar(None::<&gtk::Widget>);
    window.set_decorated(true);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ssd_keeps_tauri_window_decorations() {
        assert!(tauri_decorations_enabled(LinuxWindowDecoration::Ssd));
        assert!(!tauri_decorations_enabled(LinuxWindowDecoration::Csd));
    }
}
