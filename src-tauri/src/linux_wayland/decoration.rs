use gtk::prelude::*;

use super::LinuxWindowDecoration;

const INTEGRATED_CSD_CLASS: &str = "risu-integrated-csd";

fn reset_header_decoration_layout(header: &gtk::HeaderBar) {
    header.set_decoration_layout(None);
    header.set_decoration_layout_set(false);
}

pub fn prepare_client_side_decoration(
    window: &gtk::ApplicationWindow,
    requested: LinuxWindowDecoration,
) -> bool {
    if requested != LinuxWindowDecoration::Csd || window.is_realized() {
        return false;
    }

    let Some(titlebar) = window.titlebar() else {
        return false;
    };

    let provider = gtk::CssProvider::new();
    if provider
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
"#,
        )
        .is_err()
    {
        return false;
    }

    titlebar.style_context().add_class(INTEGRATED_CSD_CLASS);
    titlebar
        .style_context()
        .add_provider(&provider, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);

    if let Ok(event_box) = titlebar.downcast::<gtk::EventBox>() {
        if let Some(child) = event_box.child() {
            child.style_context().add_class(INTEGRATED_CSD_CLASS);
            child
                .style_context()
                .add_provider(&provider, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);

            if let Ok(header) = child.downcast::<gtk::HeaderBar>() {
                // Tao hardcodes "menu:minimize,maximize,close". Clear that
                // override so GtkSettings/desktop policy chooses the native
                // decoration layout and button placement.
                reset_header_decoration_layout(&header);

                // Tao also reapplies its hardcoded layout when resizability
                // changes. Our handler is connected afterwards, so restore the
                // GtkSettings-driven layout after Tao's callback runs.
                let header_weak = header.downgrade();
                window.connect_resizable_notify(move |_| {
                    if let Some(header) = header_weak.upgrade() {
                        reset_header_decoration_layout(&header);
                    }
                });
            }
        }
    }

    true
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
}
