use gtk::prelude::*;
use std::{
    cell::RefCell,
    env, fs,
    path::{Path, PathBuf},
};
use tauri::{Runtime, Window};

use super::LinuxWindowDecoration;

const INTEGRATED_CSD_CLASS: &str = "risu-integrated-csd";
const NATIVE_THEME_PRIORITY: u32 = gtk::STYLE_PROVIDER_PRIORITY_USER + 1;
const INTEGRATED_CSD_PRIORITY: u32 = gtk::STYLE_PROVIDER_PRIORITY_USER + 2;

thread_local! {
    static NATIVE_THEME_PROVIDER: RefCell<Option<(gtk::gdk::Screen, gtk::CssProvider)>> =
        const { RefCell::new(None) };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rgb(u8, u8, u8);

impl Rgb {
    fn as_kde(self) -> String {
        format!("{},{},{}", self.0, self.1, self.2)
    }

    fn as_kde_background(self, alpha: Option<u8>) -> String {
        match alpha {
            Some(alpha) if alpha < u8::MAX => {
                format!("{},{},{},{}", self.0, self.1, self.2, alpha)
            }
            _ => self.as_kde(),
        }
    }
}

fn parse_hex_color(value: &str) -> Result<Rgb, String> {
    let value = value.trim();
    let hex = value
        .strip_prefix('#')
        .ok_or_else(|| format!("Expected #RRGGBB color, got {value}"))?;
    if hex.len() != 6 {
        return Err(format!("Expected #RRGGBB color, got {value}"));
    }

    let channel = |start: usize| {
        u8::from_str_radix(&hex[start..start + 2], 16)
            .map_err(|_| format!("Invalid #RRGGBB color: {value}"))
    };
    Ok(Rgb(channel(0)?, channel(2)?, channel(4)?))
}

fn ini_value<'a>(contents: &'a str, section: &str, key: &str) -> Option<&'a str> {
    let mut active_section = "";

    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            active_section = &line[1..line.len() - 1];
            continue;
        }
        if active_section != section {
            continue;
        }

        let Some((candidate, value)) = line.split_once('=') else {
            continue;
        };
        if candidate.trim() == key {
            return Some(value.trim());
        }
    }

    None
}

fn parse_kde_color_alpha(value: &str) -> Option<u8> {
    let mut channels = value.split(',').map(str::trim);
    let _red = channels.next()?.parse::<u8>().ok()?;
    let _green = channels.next()?.parse::<u8>().ok()?;
    let _blue = channels.next()?.parse::<u8>().ok()?;
    match channels.next() {
        Some(alpha) => alpha.parse::<u8>().ok(),
        None => Some(u8::MAX),
    }
}

fn kde_config_home() -> Option<PathBuf> {
    env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
}

fn kde_data_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Some(path) = env::var_os("XDG_DATA_HOME") {
        roots.push(PathBuf::from(path));
    } else if let Some(home) = env::var_os("HOME") {
        roots.push(PathBuf::from(home).join(".local/share"));
    }

    match env::var_os("XDG_DATA_DIRS") {
        Some(paths) => roots.extend(env::split_paths(&paths)),
        None => {
            roots.push(PathBuf::from("/usr/local/share"));
            roots.push(PathBuf::from("/usr/share"));
        }
    }

    roots
}

fn titlebar_alpha_from_colors(contents: &str) -> Option<u8> {
    ini_value(contents, "Colors:Header", "BackgroundNormal")
        .and_then(parse_kde_color_alpha)
        .or_else(|| {
            ini_value(contents, "Colors:Window", "BackgroundNormal").and_then(parse_kde_color_alpha)
        })
        .or_else(|| ini_value(contents, "WM", "activeBackground").and_then(parse_kde_color_alpha))
}

fn svg_attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let pattern = format!("{name}=\"");
    let start = tag.find(&pattern)? + pattern.len();
    let rest = &tag[start..];
    Some(&rest[..rest.find('"')?])
}

fn svg_style_property<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let style = svg_attribute(tag, "style")?;
    style.split(';').find_map(|entry| {
        let (property, value) = entry.split_once(':')?;
        (property.trim() == name).then(|| value.trim())
    })
}

fn parse_svg_opacity(value: &str) -> Option<f64> {
    let value = value.trim();
    let opacity = match value.strip_suffix('%') {
        Some(percent) => percent.trim().parse::<f64>().ok()? / 100.0,
        None => value.parse::<f64>().ok()?,
    };
    Some(opacity.clamp(0.0, 1.0))
}

fn aurorae_center_alpha(contents: &str) -> Option<u8> {
    let marker = "id=\"decoration-center\"";
    let id = contents.find(marker)?;
    let tag_start = contents[..id].rfind('<')?;
    let tag_end = id + contents[id..].find('>')? + 1;
    let tag = &contents[tag_start..tag_end];

    let opacity = svg_attribute(tag, "opacity")
        .or_else(|| svg_style_property(tag, "opacity"))
        .and_then(parse_svg_opacity)
        .unwrap_or(1.0);
    let fill_opacity = svg_attribute(tag, "fill-opacity")
        .or_else(|| svg_style_property(tag, "fill-opacity"))
        .and_then(parse_svg_opacity)
        .unwrap_or(1.0);

    Some((opacity * fill_opacity * f64::from(u8::MAX)).round() as u8)
}

fn aurorae_titlebar_alpha() -> Option<u8> {
    let config_home = kde_config_home()?;
    let kwinrc = fs::read_to_string(config_home.join("kwinrc")).ok()?;
    let library = ini_value(&kwinrc, "org.kde.kdecoration2", "library")?;
    if !library.starts_with("org.kde.kwin.aurorae") {
        return None;
    }

    let theme = ini_value(&kwinrc, "org.kde.kdecoration2", "theme")?;
    let theme = theme.strip_prefix("__aurorae__svg__").unwrap_or(theme);

    for root in kde_data_roots() {
        let path = root
            .join("aurorae/themes")
            .join(theme)
            .join("decoration.svg");
        if let Ok(contents) = fs::read_to_string(path) {
            if let Some(alpha) = aurorae_center_alpha(&contents) {
                return Some(alpha);
            }
        }
    }

    None
}

fn kde_palette_titlebar_alpha() -> Option<u8> {
    let kdeglobals = kde_config_home()?.join("kdeglobals");
    let contents = fs::read_to_string(&kdeglobals).ok()?;

    if let Some(alpha) = titlebar_alpha_from_colors(&contents) {
        return Some(alpha);
    }

    let scheme = ini_value(&contents, "General", "ColorScheme")?;
    for root in kde_data_roots() {
        let path = root.join("color-schemes").join(format!("{scheme}.colors"));
        if let Ok(contents) = fs::read_to_string(path) {
            if let Some(alpha) = titlebar_alpha_from_colors(&contents) {
                return Some(alpha);
            }
        }
    }

    None
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct KdeTitlebarAlpha {
    pub palette: Option<u8>,
    pub effective: Option<u8>,
}

pub fn kde_titlebar_alphas() -> KdeTitlebarAlpha {
    let palette = kde_palette_titlebar_alpha();
    let intrinsic = aurorae_titlebar_alpha();
    let effective = match (palette, intrinsic) {
        (Some(palette), Some(intrinsic)) => {
            Some(((u16::from(palette) * u16::from(intrinsic) + 127) / u16::from(u8::MAX)) as u8)
        }
        (Some(palette), None) => Some(palette),
        (None, Some(intrinsic)) => Some(intrinsic),
        (None, None) => None,
    };

    KdeTitlebarAlpha { palette, effective }
}

pub fn write_kwin_decoration_palette(
    path: &Path,
    background: &str,
    foreground: &str,
    inactive_foreground: &str,
    accent: &str,
    negative: &str,
    background_alpha: Option<u8>,
) -> Result<(), String> {
    let background = parse_hex_color(background)?.as_kde_background(background_alpha);
    let foreground = parse_hex_color(foreground)?.as_kde();
    let inactive_foreground = parse_hex_color(inactive_foreground)?.as_kde();
    let accent = parse_hex_color(accent)?.as_kde();
    let negative = parse_hex_color(negative)?.as_kde();

    let parent = path
        .parent()
        .ok_or_else(|| "KWin decoration palette path has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;

    // KWin reads Colors:Header for modern decorations and WM for legacy ones.
    // Keep the palette file stable instead of atomically replacing it: KWin's
    // KConfigWatcher watches this exact path and should see live theme changes.
    let palette = format!(
        "[Colors:Header]\nBackgroundAlternate={background}\nBackgroundNormal={background}\nDecorationFocus={accent}\nDecorationHover={accent}\nForegroundActive={foreground}\nForegroundInactive={inactive_foreground}\nForegroundNegative={negative}\nForegroundNormal={foreground}\n\n[Colors:Header][Inactive]\nBackgroundAlternate={background}\nBackgroundNormal={background}\nDecorationFocus={accent}\nDecorationHover={accent}\nForegroundActive={foreground}\nForegroundInactive={inactive_foreground}\nForegroundNegative={negative}\nForegroundNormal={inactive_foreground}\n\n[Colors:Window]\nBackgroundAlternate={background}\nBackgroundNormal={background}\nDecorationFocus={accent}\nDecorationHover={accent}\nForegroundActive={foreground}\nForegroundInactive={inactive_foreground}\nForegroundNegative={negative}\nForegroundNormal={foreground}\n\n[WM]\nactiveBackground={background}\nactiveForeground={foreground}\nframe={background}\ninactiveBackground={background}\ninactiveForeground={inactive_foreground}\ninactiveFrame={background}\n\n[General]\nColorScheme=RisuAI\nName=RisuAI\n"
    );
    fs::write(path, palette).map_err(|error| error.to_string())
}

pub fn ensure_kwin_decoration_palette(
    path: &Path,
    dark: bool,
    background_alpha: Option<u8>,
) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }

    if dark {
        write_kwin_decoration_palette(
            path,
            "#21222c",
            "#f8f8f2",
            "#94a3b8",
            "#6272a4",
            "#ff5555",
            background_alpha,
        )
    } else {
        write_kwin_decoration_palette(
            path,
            "#f0f0f0",
            "#0f172a",
            "#64748b",
            "#94a3b8",
            "#dc2626",
            background_alpha,
        )
    }
}

pub fn bootstrap_decorations_enabled(decoration: LinuxWindowDecoration) -> bool {
    decoration == LinuxWindowDecoration::Ssd
}

fn configure_integrated_header(header: &gtk::HeaderBar) {
    header.set_decoration_layout(None);
    header.set_decoration_layout_set(false);
    header.set_title(None);
    header.set_subtitle(None);
    header.set_has_subtitle(false);
}

fn extract_named_color_declarations(css: &str) -> String {
    let mut declarations = String::new();
    let mut remaining = css;

    while let Some(start) = remaining.find("@define-color") {
        remaining = &remaining[start..];
        let Some(end) = remaining.find(';') else {
            break;
        };

        declarations.push_str(remaining[..=end].trim());
        declarations.push('\n');
        remaining = &remaining[end + 1..];
    }

    declarations
}

fn replace_native_theme_provider(screen: &gtk::gdk::Screen, provider: Option<gtk::CssProvider>) {
    NATIVE_THEME_PROVIDER.with(|slot| {
        let mut slot = slot.borrow_mut();
        if let Some((previous_screen, previous_provider)) = slot.take() {
            gtk::StyleContext::remove_provider_for_screen(&previous_screen, &previous_provider);
        }

        if let Some(provider) = provider {
            gtk::StyleContext::add_provider_for_screen(screen, &provider, NATIVE_THEME_PRIORITY);
            *slot = Some((screen.clone(), provider));
        }
    });
}

pub fn apply_native_theme_variant(
    window: &gtk::ApplicationWindow,
    dark: bool,
) -> Result<(), String> {
    let settings = window
        .settings()
        .ok_or_else(|| "GTK settings are unavailable".to_string())?;
    let theme_name = settings
        .gtk_theme_name()
        .ok_or_else(|| "GTK theme name is unavailable".to_string())?;
    // KDE's GTK integration can install user-priority color definitions for
    // the desktop color scheme. When RisuAI uses the opposite appearance,
    // those definitions still win over GTK's selected theme variant. Reapply
    // only the named colors exported by the theme itself; copying its widget
    // rules would replace the user's native button shapes and behavior.
    let named_provider =
        gtk::CssProvider::named(theme_name.as_str(), if dark { Some("dark") } else { None })
            .or_else(|| gtk::CssProvider::named(theme_name.as_str(), None))
            .ok_or_else(|| format!("GTK theme is unavailable: {theme_name}"))?;
    let named_colors = extract_named_color_declarations(&named_provider.to_string());
    let screen = gtk::prelude::WidgetExt::screen(window)
        .ok_or_else(|| "GTK screen is unavailable".to_string())?;

    let provider = if named_colors.is_empty() {
        None
    } else {
        let provider = gtk::CssProvider::new();
        provider
            .load_from_data(named_colors.as_bytes())
            .map_err(|error| format!("Failed to load GTK theme colors: {error}"))?;
        Some(provider)
    };
    replace_native_theme_provider(&screen, provider);
    gtk::StyleContext::reset_widgets(&screen);
    Ok(())
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
"#,
        )
        .map_err(|error| format!("Failed to style GTK CSD: {error}"))?;

    if let Some(screen) = gtk::prelude::WidgetExt::screen(window) {
        gtk::StyleContext::add_provider_for_screen(&screen, &provider, INTEGRATED_CSD_PRIORITY);
    }

    titlebar.style_context().add_class(INTEGRATED_CSD_CLASS);
    titlebar
        .style_context()
        .add_provider(&provider, INTEGRATED_CSD_PRIORITY);

    event_box.set_above_child(false);
    header.style_context().add_class(INTEGRATED_CSD_CLASS);
    header
        .style_context()
        .add_provider(&provider, INTEGRATED_CSD_PRIORITY);
    configure_integrated_header(&header);

    let header_weak = header.downgrade();
    window.connect_resizable_notify(move |_| {
        if let Some(header) = header_weak.upgrade() {
            configure_integrated_header(&header);
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
    fn parses_kde_palette_hex_colors() {
        assert_eq!(parse_hex_color("#21222c").unwrap(), Rgb(33, 34, 44));
        assert!(parse_hex_color("rgb(1, 2, 3)").is_err());
        assert!(parse_hex_color("#fff").is_err());
    }

    #[test]
    fn reads_kde_titlebar_alpha_from_header_colors() {
        let colors = r#"
[Colors:Window]
BackgroundNormal=1,2,3
[Colors:Header]
BackgroundNormal=33,34,44,192
"#;

        assert_eq!(titlebar_alpha_from_colors(colors), Some(192));
        assert_eq!(parse_kde_color_alpha("33,34,44"), Some(255));
        assert_eq!(parse_kde_color_alpha("33,34,44,128"), Some(128));
    }

    #[test]
    fn preserves_kde_alpha_when_serializing_risu_background() {
        assert_eq!(Rgb(33, 34, 44).as_kde_background(Some(192)), "33,34,44,192");
        assert_eq!(Rgb(33, 34, 44).as_kde_background(Some(255)), "33,34,44");
    }

    #[test]
    fn reads_aurorae_decoration_center_opacity() {
        let svg = r#"
<svg>
  <rect
    style="opacity:0.82;fill:#161925;fill-opacity:1"
    id="decoration-center"
  />
</svg>
"#;

        assert_eq!(aurorae_center_alpha(svg), Some(209));
    }

    #[test]
    fn extracts_theme_defined_colors_without_copying_widget_rules() {
        let css = r#"
@define-color theme_fg_color rgb(240, 240, 240);
button { color: @theme_fg_color; }
@define-color theme_specific_titlebar_color @theme_fg_color;
"#;

        assert_eq!(
            extract_named_color_declarations(css),
            "@define-color theme_fg_color rgb(240, 240, 240);\n\
             @define-color theme_specific_titlebar_color @theme_fg_color;\n"
        );
    }

    #[test]
    fn ignores_incomplete_named_color_declarations() {
        assert_eq!(
            extract_named_color_declarations("@define-color theme_fg_color #fff"),
            ""
        );
    }

    #[test]
    fn only_ssd_bootstraps_with_server_decorations_enabled() {
        assert!(bootstrap_decorations_enabled(LinuxWindowDecoration::Ssd));
        assert!(!bootstrap_decorations_enabled(LinuxWindowDecoration::Csd));
    }
}
