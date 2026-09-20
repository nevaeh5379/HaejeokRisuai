use gtk::prelude::*;
use tauri::{Runtime, Window};

use super::LinuxWindowDecoration;

const INTEGRATED_CSD_CLASS: &str = "risu-integrated-csd";
const NATIVE_DARK_CLASS: &str = "risu-native-dark";
const NATIVE_LIGHT_CLASS: &str = "risu-native-light";

pub fn bootstrap_decorations_enabled(decoration: LinuxWindowDecoration) -> bool {
    decoration == LinuxWindowDecoration::Ssd
}

fn reset_header_decoration_layout(header: &gtk::HeaderBar) {
    header.set_decoration_layout(None);
    header.set_decoration_layout_set(false);
}

fn native_appearance_class(dark: bool) -> &'static str {
    if dark {
        NATIVE_DARK_CLASS
    } else {
        NATIVE_LIGHT_CLASS
    }
}

pub fn set_native_appearance_class(window: &gtk::ApplicationWindow, dark: bool) {
    let style = window.style_context();
    style.remove_class(NATIVE_DARK_CLASS);
    style.remove_class(NATIVE_LIGHT_CLASS);
    style.add_class(native_appearance_class(dark));
}

fn install_header_drag_behavior(window: &gtk::ApplicationWindow, event_box: &gtk::EventBox) {
    event_box.add_events(gtk::gdk::EventMask::BUTTON_PRESS_MASK);

    let window = window.clone();
    event_box.connect_button_press_event(move |event_box, event| {
        if event.button() != 1 {
            return gtk::glib::Propagation::Proceed;
        }

        let (x, y) = event.position();
        let allocation = event_box.allocation();
        if y <= 6.0 && !window.is_maximized() && window.is_resizable() {
            let edge = if x <= 6.0 {
                gtk::gdk::WindowEdge::NorthWest
            } else if x >= f64::from(allocation.width()) - 6.0 {
                gtk::gdk::WindowEdge::NorthEast
            } else {
                gtk::gdk::WindowEdge::North
            };

            if let Some(gdk_window) = window.window() {
                let (root_x, root_y) = event.root();
                gdk_window.begin_resize_drag(
                    edge,
                    event.button() as i32,
                    root_x as i32,
                    root_y as i32,
                    event.time(),
                );
                return gtk::glib::Propagation::Stop;
            }
        }

        match event.event_type() {
            gtk::gdk::EventType::DoubleButtonPress => {
                if window.is_maximized() {
                    window.unmaximize();
                } else if window.is_resizable() {
                    window.maximize();
                }
                gtk::glib::Propagation::Stop
            }
            gtk::gdk::EventType::ButtonPress => {
                let (root_x, root_y) = event.root();
                window.begin_move_drag(
                    event.button() as i32,
                    root_x as i32,
                    root_y as i32,
                    event.time(),
                );
                gtk::glib::Propagation::Stop
            }
            _ => gtk::glib::Propagation::Proceed,
        }
    });
}

pub fn prepare_client_side_decoration<R: Runtime>(
    tauri_window: &Window<R>,
    window: &gtk::ApplicationWindow,
    requested: LinuxWindowDecoration,
) -> Result<bool, String> {
    if requested != LinuxWindowDecoration::Csd || window.is_realized() {
        return Ok(false);
    }

    let titlebar = window
        .titlebar()
        .ok_or_else(|| "Tao did not create a GTK titlebar".to_string())?;
    let event_box = titlebar
        .clone()
        .downcast::<gtk::EventBox>()
        .map_err(|_| "Tao GTK titlebar is not an EventBox".to_string())?;
    let header = event_box
        .child()
        .ok_or_else(|| "Tao GTK titlebar EventBox has no child".to_string())?
        .downcast::<gtk::HeaderBar>()
        .map_err(|_| "Tao GTK titlebar child is not a HeaderBar".to_string())?;
    let default_vbox = tauri_window
        .default_vbox()
        .map_err(|error| error.to_string())?;
    let children = default_vbox.children();

    if children.len() != 1 {
        return Err(format!(
            "Cannot overlay GTK CSD safely: default Tauri vbox contains {} children",
            children.len()
        ));
    }

    let content = children[0].clone();

    let provider = gtk::CssProvider::new();
    provider
        .load_from_data(
            br#"
.risu-integrated-csd,
.risu-integrated-csd headerbar,
headerbar.risu-integrated-csd {
  background-color: transparent;
  background-image: none;
  border: none;
  box-shadow: none;
}

window.risu-native-dark .risu-integrated-csd,
window.risu-native-dark .risu-integrated-csd button.titlebutton {
  color: rgba(255, 255, 255, 0.92);
  -gtk-icon-shadow: none;
  text-shadow: none;
}

window.risu-native-light .risu-integrated-csd,
window.risu-native-light .risu-integrated-csd button.titlebutton {
  color: rgba(0, 0, 0, 0.82);
  -gtk-icon-shadow: none;
  text-shadow: none;
}

.risu-integrated-csd button.titlebutton {
  background-color: transparent;
  border-color: transparent;
  box-shadow: none;
}

window.risu-native-dark .risu-integrated-csd button.titlebutton:hover {
  background-color: rgba(255, 255, 255, 0.14);
}

window.risu-native-dark .risu-integrated-csd button.titlebutton:active {
  background-color: rgba(255, 255, 255, 0.22);
}

window.risu-native-light .risu-integrated-csd button.titlebutton:hover {
  background-color: rgba(0, 0, 0, 0.11);
}

window.risu-native-light .risu-integrated-csd button.titlebutton:active {
  background-color: rgba(0, 0, 0, 0.18);
}

.risu-integrated-csd button.titlebutton.close:hover,
.risu-integrated-csd button.titlebutton.close:active {
  background-color: #e81123;
  color: white;
}
"#,
        )
        .map_err(|error| format!("Failed to style GTK CSD: {error}"))?;

    if let Some(screen) = gtk::prelude::WidgetExt::screen(window) {
        gtk::StyleContext::add_provider_for_screen(
            &screen,
            &provider,
            gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
        );
    }

    let dark = window
        .settings()
        .map(|settings| settings.is_gtk_application_prefer_dark_theme())
        .unwrap_or(false);
    set_native_appearance_class(window, dark);

    titlebar.style_context().add_class(INTEGRATED_CSD_CLASS);
    titlebar
        .style_context()
        .add_provider(&provider, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);

    event_box.set_above_child(false);
    header.style_context().add_class(INTEGRATED_CSD_CLASS);
    header
        .style_context()
        .add_provider(&provider, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
    reset_header_decoration_layout(&header);

    let header_weak = header.downgrade();
    window.connect_resizable_notify(move |_| {
        if let Some(header) = header_weak.upgrade() {
            reset_header_decoration_layout(&header);
        }
    });

    // Tao's HeaderBar is a no-window widget. Its surrounding EventBox owns the
    // GDK input surface, so window dragging and top-edge resizing must be
    // handled there while native title buttons keep receiving their own input.
    install_header_drag_behavior(window, &event_box);

    // Keep the WebView exactly two GTK parents below the window. Tauri's Linux
    // resize handler assumes `WebView -> container -> Window`; retaining the
    // default vbox around this overlay would make that handler downcast the
    // vbox to GtkWindow and panic on pointer input near a window edge.
    //
    // The default vbox is intentionally detached only after validating that it
    // contains the single WebView created for this WebviewWindow. RisuAI does
    // not add menus or additional child webviews to these native windows.
    default_vbox.remove(&content);

    // Keep GTK in client-decoration mode while the real HeaderBar moves into
    // the content overlay. Setting the titlebar to None makes GTK immediately
    // negotiate KWin SSD, even when set_decorated(false) follows. A hidden,
    // zero-height native titlebar anchor preserves GTK's CSD protocol state
    // without reserving a second titlebar row above the WebView.
    let csd_anchor = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    csd_anchor.set_size_request(-1, 0);
    csd_anchor.set_no_show_all(true);
    csd_anchor.hide();
    window.set_titlebar(Some(&csd_anchor));
    window.set_decorated(true);
    window.remove(&default_vbox);

    let overlay = gtk::Overlay::new();
    overlay.add(&content);

    titlebar.set_halign(gtk::Align::Fill);
    titlebar.set_valign(gtk::Align::Start);
    titlebar.set_hexpand(true);
    titlebar.set_vexpand(false);
    overlay.add_overlay(&titlebar);
    overlay.set_overlay_pass_through(&titlebar, false);

    window.add(&overlay);
    overlay.show_all();

    Ok(true)
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
    fn integrated_csd_class_is_scoped() {
        assert_eq!(INTEGRATED_CSD_CLASS, "risu-integrated-csd");
    }

    #[test]
    fn native_appearance_uses_exclusive_window_classes() {
        assert_eq!(native_appearance_class(true), NATIVE_DARK_CLASS);
        assert_eq!(native_appearance_class(false), NATIVE_LIGHT_CLASS);
        assert_ne!(NATIVE_DARK_CLASS, NATIVE_LIGHT_CLASS);
    }

    #[test]
    fn only_ssd_bootstraps_with_server_decorations_enabled() {
        assert!(bootstrap_decorations_enabled(LinuxWindowDecoration::Ssd));
        assert!(!bootstrap_decorations_enabled(LinuxWindowDecoration::Csd));
    }
}
