use std::{cell::RefCell, rc::Rc};

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
use wayland_protocols_plasma::blur::client::{org_kde_kwin_blur, org_kde_kwin_blur_manager};

use super::{decoration, BackgroundBlurSupport, LinuxWindowCapabilities};

const STANDARD_BLUR_MANAGER: &str = "ext_background_effect_manager_v1";
const KWIN_BLUR_MANAGER: &str = "org_kde_kwin_blur_manager";
const XDG_DECORATION_MANAGER: &str = "zxdg_decoration_manager_v1";
const KWIN_DECORATION_MANAGER: &str = "org_kde_kwin_server_decoration_manager";

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

struct WaylandEffectSession {
    connection: Connection,
    event_queue: EventQueue<RegistryState>,
    state: RegistryState,
    _registry: wl_registry::WlRegistry,
    compositor: wl_compositor::WlCompositor,
    _surface: wl_surface::WlSurface,
    effect: BackgroundEffect,
    cleaned: bool,
}

impl WaylandEffectSession {
    fn update_region(&mut self, width: i32, height: i32) -> Result<(), String> {
        let _ = self.event_queue.dispatch_pending(&mut self.state);
        let qh = self.event_queue.handle();
        let region = self.compositor.create_region(&qh, ());
        region.add(0, 0, width.max(1), height.max(1));

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
        self.connection.flush().map_err(|error| error.to_string())
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

pub fn install<R: Runtime>(window: &Window<R>) -> Result<LinuxWindowCapabilities, String> {
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
    // GTK3 does not expose its xdg_toplevel and does not bind xdg-decoration
    // itself. Its usable SSD path on current Tao/Tauri is KWin's legacy
    // server-decoration protocol, so only remove Tao's HeaderBar when that
    // protocol is actually present.
    let server_side_decoration = state.has_global(KWIN_DECORATION_MANAGER);
    let using_server_side_decoration =
        decoration::prefer_server_side_decoration(&gtk_window, server_side_decoration);
    if using_server_side_decoration {
        eprintln!("[Linux Wayland] Removed Tao GTK header bar before realization");
    } else if server_side_decoration && gtk_window.is_realized() {
        eprintln!("[Linux Wayland] Window was realized before decoration negotiation");
    } else if standard_decoration_advertised && !server_side_decoration {
        eprintln!(
            "[Linux Wayland] xdg-decoration is advertised but GTK3 cannot safely attach to its xdg_toplevel; keeping CSD"
        );
    }

    gtk_window.show_all();
    let surface = wrap_gtk_surface(&connection, &gtk_window)?;

    let compositor = bind_compositor(&registry, &state, &qh)?;
    let (effect, background_blur) =
        create_effect(&registry, &mut state, &mut event_queue, &surface)?;

    let session = Rc::new(RefCell::new(WaylandEffectSession {
        connection,
        event_queue,
        state,
        _registry: registry,
        compositor,
        _surface: surface,
        effect,
        cleaned: false,
    }));

    if background_blur != BackgroundBlurSupport::None {
        let allocation = gtk_window.allocation();
        session
            .borrow_mut()
            .update_region(allocation.width(), allocation.height())?;
        gtk_window.queue_draw();

        let resize_session = Rc::clone(&session);
        gtk_window.connect_size_allocate(move |window, allocation| {
            if let Err(error) = resize_session
                .borrow_mut()
                .update_region(allocation.width(), allocation.height())
            {
                eprintln!("[Linux Wayland] Failed to update blur region: {error}");
            }
            window.queue_draw();
        });
    }

    let destroy_session = Rc::clone(&session);
    gtk_window.connect_destroy(move |_| {
        destroy_session.borrow_mut().cleanup();
    });

    Ok(LinuxWindowCapabilities {
        wayland: true,
        server_side_decoration,
        background_blur,
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
    }

    #[test]
    fn blur_preference_keeps_standard_before_kwin_fallback() {
        assert_eq!(STANDARD_BLUR_MANAGER, "ext_background_effect_manager_v1");
        assert_eq!(KWIN_BLUR_MANAGER, "org_kde_kwin_blur_manager");
    }
}
