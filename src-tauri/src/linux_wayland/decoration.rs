use gtk::prelude::*;

fn should_prefer_server_side_decoration(supported: bool) -> bool {
    supported
}

pub fn prefer_server_side_decoration(window: &gtk::ApplicationWindow, supported: bool) -> bool {
    if !should_prefer_server_side_decoration(supported) || window.is_realized() {
        return false;
    }

    // Tao 0.35 installs a GtkHeaderBar for every Wayland window. Removing that
    // explicit custom titlebar before realization lets GTK negotiate the normal
    // decorated window path with compositors that advertise SSD support.
    window.set_titlebar(None::<&gtk::Widget>);
    window.set_decorated(true);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_side_path_is_capability_gated() {
        assert!(should_prefer_server_side_decoration(true));
        assert!(!should_prefer_server_side_decoration(false));
    }
}
