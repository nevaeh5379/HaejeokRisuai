use std::{cell::RefCell, path::Path, rc::Rc};

use gtk::prelude::*;
use tauri::{Runtime, Window};
use wayland_backend::client::{Backend, ObjectId};
use wayland_client::{
    delegate_noop,
    protocol::{wl_compositor, wl_region, wl_registry, wl_surface},
    Connection, Dispatch, EventQueue, Proxy, QueueHandle, WEnum,
};
use wayland_protocols::ext::background_effect::v1::client::{
    ext_background_effect_manager_v1, ext_background_effect_surface_v1,
};
use wayland_protocols_plasma::{
    blur::client::{org_kde_kwin_blur, org_kde_kwin_blur_manager},
    server_decoration_palette::client::{
        org_kde_kwin_server_decoration_palette, org_kde_kwin_server_decoration_palette_manager,
    },
};

use super::{decoration, BackgroundBlurSupport, LinuxWindowCapabilities, LinuxWindowDecoration};

const STANDARD_BLUR_MANAGER: &str = "ext_background_effect_manager_v1";
const KWIN_BLUR_MANAGER: &str = "org_kde_kwin_blur_manager";
const XDG_DECORATION_MANAGER: &str = "zxdg_decoration_manager_v1";
const KWIN_DECORATION_MANAGER: &str = "org_kde_kwin_server_decoration_manager";
const KWIN_DECORATION_PALETTE_MANAGER: &str = "org_kde_kwin_server_decoration_palette_manager";

#[derive(Debug, Clone)]
struct Global {
    name: u32,
    interface: String,
    version: u32,
}

#[derive(Default)]
struct RegistryState {
    globals: Vec<Global>,
    standard_blur_capable: bool,
}

impl RegistryState {
    fn global(&self, interface: &str) -> Option<&Global> {
        self.globals
            .iter()
            .find(|global| global.interface == interface)
    }

    fn has_global(&self, interface: &str) -> bool {
        self.global(interface).is_some()
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for RegistryState {
    fn event(
        state: &mut Self,
        _registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _data: &(),
        _connection: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        match event {
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } => {
                state.globals.retain(|global| global.name != name);
                state.globals.push(Global {
                    name,
                    interface,
                    version,
                });
            }
            wl_registry::Event::GlobalRemove { name } => {
                state.globals.retain(|global| global.name != name);
            }
            _ => {}
        }
    }
}

impl Dispatch<ext_background_effect_manager_v1::ExtBackgroundEffectManagerV1, ()>
    for RegistryState
{
    fn event(
        state: &mut Self,
        _manager: &ext_background_effect_manager_v1::ExtBackgroundEffectManagerV1,
        event: ext_background_effect_manager_v1::Event,
        _data: &(),
        _connection: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        if let ext_background_effect_manager_v1::Event::Capabilities { flags } = event {
            state.standard_blur_capable = matches!(
                flags,
                WEnum::Value(value)
                    if value.contains(ext_background_effect_manager_v1::Capability::Blur)
            );
        }
    }
}

delegate_noop!(RegistryState: ignore wl_compositor::WlCompositor);
delegate_noop!(RegistryState: ignore wl_region::WlRegion);
delegate_noop!(RegistryState: ignore ext_background_effect_surface_v1::ExtBackgroundEffectSurfaceV1);
delegate_noop!(RegistryState: ignore org_kde_kwin_blur_manager::OrgKdeKwinBlurManager);
delegate_noop!(RegistryState: ignore org_kde_kwin_blur::OrgKdeKwinBlur);
delegate_noop!(RegistryState: ignore org_kde_kwin_server_decoration_palette_manager::OrgKdeKwinServerDecorationPaletteManager);
delegate_noop!(RegistryState: ignore org_kde_kwin_server_decoration_palette::OrgKdeKwinServerDecorationPalette);

enum BackgroundEffect {
    Standard {
        manager: ext_background_effect_manager_v1::ExtBackgroundEffectManagerV1,
        surface: ext_background_effect_surface_v1::ExtBackgroundEffectSurfaceV1,
    },
    KwinLegacy {
        _manager: org_kde_kwin_blur_manager::OrgKdeKwinBlurManager,
        blur: org_kde_kwin_blur::OrgKdeKwinBlur,
    },
    None,
}

struct KwinDecorationPalette {
    _manager:
        org_kde_kwin_server_decoration_palette_manager::OrgKdeKwinServerDecorationPaletteManager,
    palette: org_kde_kwin_server_decoration_palette::OrgKdeKwinServerDecorationPalette,
}

struct WaylandEffectSession {
    connection: Connection,
    event_queue: EventQueue<RegistryState>,
    state: RegistryState,
    _registry: wl_registry::WlRegistry,
    compositor: wl_compositor::WlCompositor,
    _surface: wl_surface::WlSurface,
    effect: BackgroundEffect,
    decoration_palette: Option<KwinDecorationPalette>,
    last_blur_region: Option<(i32, i32, i32, i32, i32)>,
    cleaned: bool,
}

fn add_rounded_region(
    region: &wl_region::WlRegion,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    radius: i32,
) {
    let width = width.max(1);
    let height = height.max(1);
    let radius = radius.max(0).min(width / 2).min(height / 2);

    if radius == 0 {
        region.add(x, y, width, height);
        return;
    }

    let middle_height = height - radius * 2;
    if middle_height > 0 {
        region.add(x, y + radius, width, middle_height);
    }

    for row in 0..radius {
        let dy = f64::from(radius - row) - 0.5;
        let circle_width = (f64::from(radius * radius) - dy * dy).max(0.0).sqrt();
        let inset = (f64::from(radius) - circle_width).ceil() as i32;
        let row_width = width - inset * 2;
        if row_width > 0 {
            region.add(x + inset, y + row, row_width, 1);
            region.add(x + inset, y + height - row - 1, row_width, 1);
        }
    }
}

fn csd_blur_geometry(
    window: &gtk::ApplicationWindow,
    rounded_csd: bool,
) -> (i32, i32, i32, i32, i32) {
    let square_state = window.window().is_some_and(|gdk_window| {
        let state = gdk_window.state();
        state.intersects(
            gtk::gdk::WindowState::MAXIMIZED
                | gtk::gdk::WindowState::FULLSCREEN
                | gtk::gdk::WindowState::TILED,
        )
    });
    let corner_radius = if rounded_csd && !square_state {
        decoration::CSD_CORNER_RADIUS
    } else {
        0
    };

    if rounded_csd {
        // GTK's raw wl_surface includes the client-side shadow margins, but
        // KWin applies the blur region in the window content coordinate space
        // and intersects it with EffectWindow::contentsRect(). GtkWindow::size()
        // is exactly that margin-free CSD geometry, unlike child.allocation()
        // whose x/y include the shadow inset.
        let size = window.size();
        return (0, 0, size.0, size.1, corner_radius);
    }

    let allocation = window.allocation();
    (0, 0, allocation.width(), allocation.height(), corner_radius)
}

fn update_window_blur_region(
    session: &Rc<RefCell<WaylandEffectSession>>,
    window: &gtk::ApplicationWindow,
    rounded_csd: bool,
) -> Result<(), String> {
    let (x, y, width, height, corner_radius) = csd_blur_geometry(window, rounded_csd);
    session
        .borrow_mut()
        .update_region(x, y, width, height, corner_radius)
}

impl WaylandEffectSession {
    fn update_region(
        &mut self,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        corner_radius: i32,
    ) -> Result<(), String> {
        let geometry = (x, y, width, height, corner_radius);
        if self.last_blur_region == Some(geometry) {
            return Ok(());
        }

        let _ = self.event_queue.dispatch_pending(&mut self.state);
        let qh = self.event_queue.handle();
        let region = self.compositor.create_region(&qh, ());
        add_rounded_region(&region, x, y, width, height, corner_radius);

        match &self.effect {
            BackgroundEffect::Standard { surface, .. } => {
                surface.set_blur_region(Some(&region));
            }
            BackgroundEffect::KwinLegacy { blur, .. } => {
                blur.set_region(Some(&region));
                blur.commit();
            }
            BackgroundEffect::None => {}
        }

        region.destroy();
        self.connection.flush().map_err(|error| error.to_string())?;
        self.last_blur_region = Some(geometry);
        Ok(())
    }

    fn cleanup(&mut self) {
        if self.cleaned {
            return;
        }
        self.cleaned = true;

        match &self.effect {
            BackgroundEffect::Standard { manager, surface } => {
                surface.destroy();
                manager.destroy();
            }
            BackgroundEffect::KwinLegacy { blur, .. } => {
                blur.release();
            }
            BackgroundEffect::None => {}
        }

        if let Some(decoration_palette) = &self.decoration_palette {
            decoration_palette.palette.release();
        }

        let _ = self.connection.flush();
    }
}

fn bind_compositor(
    registry: &wl_registry::WlRegistry,
    state: &RegistryState,
    qh: &QueueHandle<RegistryState>,
) -> Result<wl_compositor::WlCompositor, String> {
    let global = state
        .global("wl_compositor")
        .ok_or_else(|| "Wayland compositor global is unavailable".to_string())?;
    Ok(registry.bind::<wl_compositor::WlCompositor, _, _>(
        global.name,
        global.version.min(6),
        qh,
        (),
    ))
}

fn wrap_foreign_surface(
    connection: &Connection,
    surface_ptr: *mut std::ffi::c_void,
) -> Result<wl_surface::WlSurface, String> {
    let object_id =
        unsafe { ObjectId::from_ptr(wl_surface::WlSurface::interface(), surface_ptr.cast()) }
            .map_err(|_| "Failed to wrap GTK wl_surface".to_string())?;

    wl_surface::WlSurface::from_id(connection, object_id)
        .map_err(|_| "Failed to create a Wayland surface proxy".to_string())
}

fn create_effect(
    registry: &wl_registry::WlRegistry,
    state: &mut RegistryState,
    event_queue: &mut EventQueue<RegistryState>,
    surface: &wl_surface::WlSurface,
) -> Result<(BackgroundEffect, BackgroundBlurSupport), String> {
    let qh = event_queue.handle();

    if let Some(global) = state.global(STANDARD_BLUR_MANAGER).cloned() {
        let manager = registry
            .bind::<ext_background_effect_manager_v1::ExtBackgroundEffectManagerV1, _, _>(
                global.name,
                global.version.min(1),
                &qh,
                (),
            );
        event_queue
            .roundtrip(state)
            .map_err(|error| format!("Failed to read background-effect capabilities: {error}"))?;

        if state.standard_blur_capable {
            let effect = manager.get_background_effect(surface, &qh, ());
            return Ok((
                BackgroundEffect::Standard {
                    manager,
                    surface: effect,
                },
                BackgroundBlurSupport::Standard,
            ));
        }

        manager.destroy();
    }

    if let Some(global) = state.global(KWIN_BLUR_MANAGER) {
        let manager = registry.bind::<org_kde_kwin_blur_manager::OrgKdeKwinBlurManager, _, _>(
            global.name,
            global.version.min(1),
            &qh,
            (),
        );
        let blur = manager.create(surface, &qh, ());
        return Ok((
            BackgroundEffect::KwinLegacy {
                _manager: manager,
                blur,
            },
            BackgroundBlurSupport::KwinLegacy,
        ));
    }

    Ok((BackgroundEffect::None, BackgroundBlurSupport::None))
}

fn create_kwin_decoration_palette(
    registry: &wl_registry::WlRegistry,
    state: &RegistryState,
    qh: &QueueHandle<RegistryState>,
    surface: &wl_surface::WlSurface,
    palette_path: &Path,
) -> Option<KwinDecorationPalette> {
    let global = state.global(KWIN_DECORATION_PALETTE_MANAGER)?;
    let manager = registry.bind::<
        org_kde_kwin_server_decoration_palette_manager::OrgKdeKwinServerDecorationPaletteManager,
        _,
        _,
    >(global.name, global.version.min(1), qh, ());
    let palette = manager.create(surface, qh, ());
    palette.set_palette(palette_path.to_string_lossy().into_owned());

    Some(KwinDecorationPalette {
        _manager: manager,
        palette,
    })
}

fn connect_to_gtk_wayland(
    gtk_window: &gtk::ApplicationWindow,
) -> Result<Option<Connection>, String> {
    let display = gtk_window.display();
    if !display.backend().is_wayland() {
        return Ok(None);
    }

    let display_ptr =
        unsafe { gdk_wayland_sys::gdk_wayland_display_get_wl_display(display.as_ptr().cast()) };
    if display_ptr.is_null() {
        return Err("GTK did not expose a Wayland display handle".to_string());
    }

    // SAFETY: GTK owns this wl_display for at least as long as the Tauri window.
    // The backend is created in guest mode and therefore never disconnects it.
    let backend = unsafe { Backend::from_foreign_display(display_ptr.cast()) };
    Ok(Some(Connection::from_backend(backend)))
}

fn wrap_gtk_surface(
    connection: &Connection,
    gtk_window: &gtk::ApplicationWindow,
) -> Result<wl_surface::WlSurface, String> {
    let gdk_window = gtk_window
        .window()
        .ok_or_else(|| "GTK window has no realized GDK window".to_string())?;
    let surface_ptr =
        unsafe { gdk_wayland_sys::gdk_wayland_window_get_wl_surface(gdk_window.as_ptr().cast()) };
    if surface_ptr.is_null() {
        return Err("GTK did not expose a Wayland surface handle".to_string());
    }

    wrap_foreign_surface(connection, surface_ptr)
}

pub fn install<R: Runtime>(
    window: &Window<R>,
    requested_decoration: LinuxWindowDecoration,
    palette_path: Option<&Path>,
) -> Result<LinuxWindowCapabilities, String> {
    let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
    let Some(connection) = connect_to_gtk_wayland(&gtk_window)? else {
        gtk_window.show_all();
        return Ok(LinuxWindowCapabilities::default());
    };

    let mut event_queue = connection.new_event_queue::<RegistryState>();
    let qh = event_queue.handle();
    let registry = connection.display().get_registry(&qh, ());
    let mut state = RegistryState::default();
    event_queue
        .roundtrip(&mut state)
        .map_err(|error| format!("Failed to enumerate Wayland globals: {error}"))?;

    let standard_decoration_advertised = state.has_global(XDG_DECORATION_MANAGER);
    // Decoration mode is fixed when the Tauri window is constructed. This
    // late Wayland integration layer only records compositor capabilities and
    // installs blur; toggling GTK decorations after WebKit has realized the
    // window is too late on Wayland.
    let server_side_decoration = state.has_global(KWIN_DECORATION_MANAGER);
    let prepared_csd =
        decoration::prepare_client_side_decoration(window, &gtk_window, requested_decoration)?;
    let prepared_ssd = decoration::prepare_server_side_decoration(
        &gtk_window,
        requested_decoration,
        server_side_decoration,
    );

    if prepared_csd {
        eprintln!("[Linux Wayland] Styled native GTK HeaderBar for integrated CSD");
    }
    if prepared_ssd {
        eprintln!("[Linux Wayland] Removed Tao GtkHeaderBar for compositor SSD");
    } else if requested_decoration == LinuxWindowDecoration::Ssd
        && standard_decoration_advertised
        && !server_side_decoration
    {
        eprintln!(
            "[Linux Wayland] SSD requested; compositor exposes xdg-decoration but GTK3 may fall back to toolkit CSD"
        );
    }

    gtk_window.show_all();
    let surface = wrap_gtk_surface(&connection, &gtk_window)?;

    let compositor = bind_compositor(&registry, &state, &qh)?;
    let (effect, background_blur) =
        create_effect(&registry, &mut state, &mut event_queue, &surface)?;
    let decoration_palette = if requested_decoration == LinuxWindowDecoration::Ssd {
        palette_path
            .and_then(|path| create_kwin_decoration_palette(&registry, &state, &qh, &surface, path))
    } else {
        None
    };

    if decoration_palette.is_some() {
        connection
            .flush()
            .map_err(|error| format!("Failed to set KWin decoration palette: {error}"))?;
        eprintln!("[Linux Wayland] Applied KWin server-decoration palette");
    }

    let session = Rc::new(RefCell::new(WaylandEffectSession {
        connection,
        event_queue,
        state,
        _registry: registry,
        compositor,
        _surface: surface,
        effect,
        decoration_palette,
        last_blur_region: None,
        cleaned: false,
    }));

    if background_blur != BackgroundBlurSupport::None {
        let rounded_csd = requested_decoration == LinuxWindowDecoration::Csd;

        // ext-background-effect applies its pending region on the next
        // wl_surface.commit. Update the region from GtkWindow::draw so GTK's
        // own draw/commit cycle applies the matching geometry in the same
        // frame instead of leaving a stale region after a resize.
        let draw_session = Rc::clone(&session);
        gtk_window.connect_draw(move |window, _cr| {
            if let Err(error) = update_window_blur_region(&draw_session, window, rounded_csd) {
                eprintln!("[Linux Wayland] Failed to update blur region: {error}");
            }
            gtk::glib::Propagation::Proceed
        });

        gtk_window.connect_size_allocate(move |window, _allocation| {
            window.queue_draw();
        });
        gtk_window.connect_window_state_event(move |window, _event| {
            window.queue_draw();
            gtk::glib::Propagation::Proceed
        });
        gtk_window.queue_draw();
    }

    let destroy_session = Rc::clone(&session);
    gtk_window.connect_destroy(move |_| {
        destroy_session.borrow_mut().cleanup();
    });

    Ok(LinuxWindowCapabilities {
        wayland: true,
        server_side_decoration,
        background_blur,
        decoration: requested_decoration,
        decoration_alpha: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoration_capability_names_are_protocol_based() {
        assert_eq!(XDG_DECORATION_MANAGER, "zxdg_decoration_manager_v1");
        assert_eq!(
            KWIN_DECORATION_MANAGER,
            "org_kde_kwin_server_decoration_manager"
        );
        assert_eq!(
            KWIN_DECORATION_PALETTE_MANAGER,
            "org_kde_kwin_server_decoration_palette_manager"
        );
    }

    #[test]
    fn blur_preference_keeps_standard_before_kwin_fallback() {
        assert_eq!(STANDARD_BLUR_MANAGER, "ext_background_effect_manager_v1");
        assert_eq!(KWIN_BLUR_MANAGER, "org_kde_kwin_blur_manager");
    }
}
