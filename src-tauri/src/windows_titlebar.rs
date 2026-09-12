use std::mem::size_of;

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime, Window,
};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{
            GetLastError, COLORREF, ERROR_CLASS_ALREADY_EXISTS, HANDLE, HINSTANCE, HWND, LPARAM,
            LRESULT, POINT, RECT, SIZE, WPARAM,
        },
        Graphics::{
            Dwm::{DwmGetWindowAttribute, DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND},
            Gdi::{
                BeginPaint, CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC,
                DeleteObject, DrawTextW, EndPaint, GetMonitorInfoW, MonitorFromRect, SelectObject,
                SetBkMode, SetTextColor, ANTIALIASED_QUALITY, BITMAPINFO, BITMAPINFOHEADER,
                BI_RGB, BLENDFUNCTION, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DIB_RGB_COLORS,
                DT_CENTER, DT_SINGLELINE, DT_VCENTER, FW_NORMAL, MONITORINFO,
                MONITOR_DEFAULTTONEAREST, OUT_DEFAULT_PRECIS, PAINTSTRUCT, TRANSPARENT,
                AC_SRC_ALPHA, AC_SRC_OVER,
            },
        },
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            Controls::WM_MOUSELEAVE,
            HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
            Input::KeyboardAndMouse::{
                TrackMouseEvent, TRACKMOUSEEVENT, TME_LEAVE, TME_NONCLIENT,
            },
            Shell::{DefSubclassProc, SetWindowSubclass},
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, GetPropW, GetWindow,
                GetWindowLongPtrW, GetWindowRect, IsZoomed, PostMessageW, RegisterClassExW,
                RemovePropW, SetPropW, SetWindowLongPtrW, SetWindowPos, UpdateLayeredWindow,
                GW_OWNER, HTCLOSE, HTCLIENT, HTMAXBUTTON, HTMINBUTTON, HTBOTTOM, HTBOTTOMLEFT,
                HTBOTTOMRIGHT, HTLEFT, HTRIGHT, HTTOP, HTTOPLEFT, HTTOPRIGHT,
                HWND_TOP, NCCALCSIZE_PARAMS, SC_CLOSE, SC_MAXIMIZE, SC_MINIMIZE, SC_RESTORE,
                SM_CXPADDEDBORDER, SM_CXSIZEFRAME, SM_CYSIZEFRAME,
                SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
                SWP_NOZORDER, SWP_SHOWWINDOW, ULW_ALPHA, WINDOW_EX_STYLE, WINDOW_STYLE,
                WM_DPICHANGED, WM_ERASEBKGND, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
                WM_NCACTIVATE, WM_NCCALCSIZE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDOWN,
                WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_PAINT, WM_SETTINGCHANGE,
                WM_SIZE, WM_SYSCOMMAND, WM_THEMECHANGED, WM_WINDOWPOSCHANGED, WS_EX_LAYERED,
                WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP, WS_VISIBLE, WNDCLASSEXW,
                GWLP_USERDATA,
            },
        },
    },
};

const RISU_FRAME_SUBCLASS_ID: usize = 0x5249_5355;
const RISU_CAPTION_SUBCLASS_ID: usize = 0x5249_5340;
const BUTTON_STATE_HOVER: isize = 1;
const BUTTON_STATE_PRESSED: isize = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CaptionButtonKind {
    Minimize = 1,
    Maximize = 2,
    Close = 3,
}

impl CaptionButtonKind {
    fn from_ref_data(value: usize) -> Option<Self> {
        match value {
            1 => Some(Self::Minimize),
            2 => Some(Self::Maximize),
            3 => Some(Self::Close),
            _ => None,
        }
    }

    fn prop_name(self) -> PCWSTR {
        match self {
            Self::Minimize => w!("RisuCaptionMinimize"),
            Self::Maximize => w!("RisuCaptionMaximize"),
            Self::Close => w!("RisuCaptionClose"),
        }
    }

    fn from_hit_test(hit: u32) -> Option<Self> {
        match hit {
            HTMINBUTTON => Some(Self::Minimize),
            HTMAXBUTTON => Some(Self::Maximize),
            HTCLOSE => Some(Self::Close),
            _ => None,
        }
    }

    fn system_command(self, parent: HWND) -> u32 {
        match self {
            Self::Minimize => SC_MINIMIZE,
            Self::Maximize if unsafe { IsZoomed(parent).as_bool() } => SC_RESTORE,
            Self::Maximize => SC_MAXIMIZE,
            Self::Close => SC_CLOSE,
        }
    }
}

fn supports_custom_frame(label: &str) -> bool {
    label == "main" || label.starts_with("chat-window-")
}

fn signed_low_word(value: isize) -> i32 {
    (value as u16 as i16) as i32
}

fn signed_high_word(value: isize) -> i32 {
    ((value >> 16) as u16 as i16) as i32
}

unsafe fn caption_metrics(hwnd: HWND) -> (i32, i32) {
    let dpi = GetDpiForWindow(hwnd).max(96);
    let scale = |logical: i32| ((logical as i64 * dpi as i64 + 48) / 96) as i32;
    (scale(46).max(1), scale(32).max(1))
}

unsafe fn caption_glyph_height(hwnd: HWND) -> i32 {
    let dpi = GetDpiForWindow(hwnd).max(96);
    -(((10_i64 * dpi as i64 + 48) / 96) as i32).max(1)
}

unsafe fn caption_corner_radius(hwnd: HWND) -> i32 {
    let dpi = GetDpiForWindow(hwnd).max(96);
    ((8_i64 * dpi as i64 + 48) / 96) as i32
}

unsafe fn button_state(hwnd: HWND) -> isize {
    GetWindowLongPtrW(hwnd, GWLP_USERDATA)
}

unsafe fn update_button_state(
    hwnd: HWND,
    kind: CaptionButtonKind,
    flag: isize,
    enabled: bool,
) {
    let current = button_state(hwnd);
    let next = if enabled {
        current | flag
    } else {
        current & !flag
    };
    if next != current {
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, next);
        if let Err(error) = render_layered_caption_button(hwnd, kind) {
            eprintln!("[Windows titlebar] Failed to render {kind:?}: {error}");
        }
    }
}

unsafe fn track_button_leave(hwnd: HWND, nonclient: bool) {
    let mut tracking = TRACKMOUSEEVENT {
        cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
        dwFlags: if nonclient { TME_LEAVE | TME_NONCLIENT } else { TME_LEAVE },
        hwndTrack: hwnd,
        dwHoverTime: 0,
    };
    let _ = TrackMouseEvent(&mut tracking);
}
unsafe fn button_owner(hwnd: HWND) -> Option<HWND> {
    GetWindow(hwnd, GW_OWNER).ok()
}

unsafe fn window_uses_dark_mode(hwnd: HWND) -> bool {
    let mut enabled: i32 = 0;
    DwmGetWindowAttribute(
        hwnd,
        DWMWA_USE_IMMERSIVE_DARK_MODE,
        &mut enabled as *mut _ as *mut core::ffi::c_void,
        size_of::<i32>() as u32,
    )
    .is_ok()
        && enabled != 0
}

fn caption_glyph(kind: CaptionButtonKind, maximized: bool) -> char {
    match kind {
        CaptionButtonKind::Minimize => '\u{E921}',
        CaptionButtonKind::Maximize if maximized => '\u{E923}',
        CaptionButtonKind::Maximize => '\u{E922}',
        CaptionButtonKind::Close => '\u{E8BB}',
    }
}

unsafe fn render_layered_caption_button(
    hwnd: HWND,
    kind: CaptionButtonKind,
) -> Result<(), String> {
    let owner = button_owner(hwnd).ok_or_else(|| "Caption button has no owner".to_string())?;
    let mut window_rect = RECT::default();
    GetWindowRect(hwnd, &mut window_rect).map_err(|error| error.to_string())?;
    let width = (window_rect.right - window_rect.left).max(1);
    let height = (window_rect.bottom - window_rect.top).max(1);

    let memory_dc = CreateCompatibleDC(None);
    if memory_dc.is_invalid() {
        return Err("CreateCompatibleDC failed".to_string());
    }

    let bitmap_info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0 as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits = std::ptr::null_mut();
    let bitmap = match CreateDIBSection(None, &bitmap_info, DIB_RGB_COLORS, &mut bits, None, 0) {
        Ok(bitmap) => bitmap,
        Err(error) => {
            let _ = DeleteDC(memory_dc);
            return Err(error.to_string());
        }
    };
    let previous = SelectObject(memory_dc, bitmap.into());
    std::ptr::write_bytes(bits, 0, (width * height * 4) as usize);

    let font_height = caption_glyph_height(owner);
    let font = CreateFontW(
        font_height,
        0,
        0,
        0,
        FW_NORMAL.0 as i32,
        0,
        0,
        0,
        DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS,
        ANTIALIASED_QUALITY,
        0,
        w!("Segoe Fluent Icons"),
    );
    if font.is_invalid() {
        SelectObject(memory_dc, previous);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory_dc);
        return Err("CreateFontW(Segoe Fluent Icons) failed".to_string());
    }
    let previous_font = SelectObject(memory_dc, font.into());
    let _ = SetBkMode(memory_dc, TRANSPARENT);
    let _ = SetTextColor(memory_dc, COLORREF(0x00ff_ffff));
    let maximized = IsZoomed(owner).as_bool();
    let mut glyph = [caption_glyph(kind, maximized) as u16];
    let mut text_rect = RECT { left: 0, top: 0, right: width, bottom: height };
    DrawTextW(memory_dc, &mut glyph, &mut text_rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    let state = button_state(hwnd);
    let hot = state & BUTTON_STATE_HOVER != 0;
    let pressed = state & BUTTON_STATE_PRESSED != 0;
    let dark = window_uses_dark_mode(owner);
    let close_hot = kind == CaptionButtonKind::Close && (hot || pressed);
    let (bg_r, bg_g, bg_b, bg_a): (u32, u32, u32, u32) = if close_hot {
        if pressed { (183, 25, 16, 255) } else { (196, 43, 28, 255) }
    } else if pressed {
        if dark { (255, 255, 255, 28) } else { (0, 0, 0, 24) }
    } else if hot {
        if dark { (255, 255, 255, 20) } else { (0, 0, 0, 18) }
    } else {
        // A fully transparent layered window is hit-tested only on its opaque
        // glyph pixels. Alpha 1 is visually transparent but keeps the entire
        // caption slot available for hover and clicks.
        (0, 0, 0, 1)
    };
    let (fg_r, fg_g, fg_b): (u32, u32, u32) = if close_hot || dark {
        (255, 255, 255)
    } else {
        (0, 0, 0)
    };

    let pixels = std::slice::from_raw_parts_mut(bits as *mut u8, (width * height * 4) as usize);
    let corner_radius = if kind == CaptionButtonKind::Close && !maximized {
        caption_corner_radius(owner)
    } else {
        0
    };
    for (index, pixel) in pixels.chunks_exact_mut(4).enumerate() {
        let mask = pixel[0].max(pixel[1]).max(pixel[2]) as u32;
        let inv = 255 - mask;
        let alpha = mask + bg_a * inv / 255;
        let blend = |fg: u32, bg: u32| -> u8 {
            (fg * mask / 255 + bg * bg_a * inv / (255 * 255)).min(255) as u8
        };
        pixel[0] = blend(fg_b, bg_b);
        pixel[1] = blend(fg_g, bg_g);
        pixel[2] = blend(fg_r, bg_r);
        pixel[3] = alpha.min(255) as u8;

        // Owned layered windows are not clipped by the DWM-rounded owner.
        // Clip the close button to the same Windows 11 top-right curve so its
        // hover fill cannot protrude beyond the window corner.
        if corner_radius > 0 {
            let x = index as i32 % width;
            let y = index as i32 / width;
            if x >= width - corner_radius && y < corner_radius {
                let dx = x - (width - corner_radius);
                let dy = y - corner_radius;
                if dx * dx + dy * dy > corner_radius * corner_radius {
                    pixel.fill(0);
                }
            }
        }
    }

    let destination = POINT { x: window_rect.left, y: window_rect.top };
    let size = SIZE { cx: width, cy: height };
    let source = POINT { x: 0, y: 0 };
    let blend = BLENDFUNCTION {
        BlendOp: AC_SRC_OVER as u8,
        BlendFlags: 0,
        SourceConstantAlpha: 255,
        AlphaFormat: AC_SRC_ALPHA as u8,
    };
    let update_result = UpdateLayeredWindow(
        hwnd,
        None,
        Some(&destination),
        Some(&size),
        Some(memory_dc),
        Some(&source),
        COLORREF(0),
        Some(&blend),
        ULW_ALPHA,
    )
    .map_err(|error| error.to_string());

    SelectObject(memory_dc, previous_font);
    let _ = DeleteObject(font.into());
    SelectObject(memory_dc, previous);
    let _ = DeleteObject(bitmap.into());
    let _ = DeleteDC(memory_dc);
    update_result
}
unsafe fn paint_caption_button(hwnd: HWND, kind: CaptionButtonKind) {
    let mut paint = PAINTSTRUCT::default();
    BeginPaint(hwnd, &mut paint);
    let _ = EndPaint(hwnd, &paint);
    if let Err(error) = render_layered_caption_button(hwnd, kind) {
        eprintln!("[Windows titlebar] Failed to render {kind:?}: {error}");
    }
}
unsafe extern "system" fn caption_button_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    ref_data: usize,
) -> LRESULT {
    let Some(kind) = CaptionButtonKind::from_ref_data(ref_data) else {
        return DefSubclassProc(hwnd, message, wparam, lparam);
    };

    match message {
        // Keep pointer input on the caption-button overlay. Passing this hit
        // through reaches the WebView's drag region and turns button clicks
        // into window drags instead of delivering the button messages below.
        WM_NCHITTEST => LRESULT(HTCLIENT as isize),
        WM_MOUSEMOVE => {
            update_button_state(hwnd, kind, BUTTON_STATE_HOVER, true);
            track_button_leave(hwnd, false);
            LRESULT(0)
        }
        WM_NCMOUSEMOVE => {
            update_button_state(hwnd, kind, BUTTON_STATE_HOVER, true);
            track_button_leave(hwnd, true);
            LRESULT(0)
        }
        WM_MOUSELEAVE | WM_NCMOUSELEAVE => {
            update_button_state(hwnd, kind, BUTTON_STATE_HOVER, false);
            update_button_state(hwnd, kind, BUTTON_STATE_PRESSED, false);
            LRESULT(0)
        }
        WM_LBUTTONDOWN | WM_NCLBUTTONDOWN => {
            update_button_state(hwnd, kind, BUTTON_STATE_PRESSED, true);
            LRESULT(0)
        }
        WM_LBUTTONUP | WM_NCLBUTTONUP => {
            update_button_state(hwnd, kind, BUTTON_STATE_PRESSED, false);
            if let Some(owner) = button_owner(hwnd) {
                let command = kind.system_command(owner);
                let _ = PostMessageW(Some(owner), WM_SYSCOMMAND, WPARAM(command as usize), LPARAM(0));
            }
            LRESULT(0)
        }
        WM_PAINT => {
            paint_caption_button(hwnd, kind);
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_THEMECHANGED | WM_SETTINGCHANGE => {
            if let Err(error) = render_layered_caption_button(hwnd, kind) {
                eprintln!("[Windows titlebar] Failed to render {kind:?}: {error}");
            }
            DefSubclassProc(hwnd, message, wparam, lparam)
        }
        _ => DefSubclassProc(hwnd, message, wparam, lparam),
    }
}

unsafe extern "system" fn caption_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    DefWindowProcW(hwnd, message, wparam, lparam)
}

unsafe fn ensure_caption_window_class() -> Result<HINSTANCE, String> {
    let module = GetModuleHandleW(None).map_err(|error| error.to_string())?;
    let instance = HINSTANCE(module.0);
    let class = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(caption_window_proc),
        hInstance: instance,
        lpszClassName: w!("RisuAICaptionButton"),
        ..Default::default()
    };

    let atom = RegisterClassExW(&class);
    if atom == 0 {
        let error = GetLastError();
        if error != ERROR_CLASS_ALREADY_EXISTS {
            return Err(format!("RegisterClassExW failed with Win32 error {}", error.0));
        }
    }

    Ok(instance)
}

unsafe fn create_caption_button(
    parent: HWND,
    kind: CaptionButtonKind,
) -> Result<HWND, String> {
    let instance = ensure_caption_window_class()?;
    let ex_style = WINDOW_EX_STYLE(WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0 | WS_EX_LAYERED.0);
    let style = WINDOW_STYLE(WS_POPUP.0 | WS_VISIBLE.0);
    let child = CreateWindowExW(
        ex_style,
        w!("RisuAICaptionButton"),
        w!(""),
        style,
        0,
        0,
        1,
        1,
        Some(parent),
        None,
        Some(instance),
        None,
    )
    .map_err(|error| format!("CreateWindowExW({kind:?}) failed: {error}"))?;

    if !SetWindowSubclass(
        child,
        Some(caption_button_proc),
        RISU_CAPTION_SUBCLASS_ID + kind as usize,
        kind as usize,
    )
    .as_bool()
    {
        let _ = DestroyWindow(child);
        return Err("SetWindowSubclass failed for caption button".to_string());
    }

    if let Err(error) = SetPropW(parent, kind.prop_name(), Some(HANDLE(child.0))) {
        let _ = DestroyWindow(child);
        return Err(format!("SetPropW({kind:?}) failed: {error}"));
    }

    Ok(child)
}

unsafe fn get_caption_button(parent: HWND, kind: CaptionButtonKind) -> Option<HWND> {
    let handle = GetPropW(parent, kind.prop_name());
    if handle.0.is_null() {
        None
    } else {
        Some(HWND(handle.0))
    }
}

unsafe fn reposition_caption_buttons(parent: HWND) {
    let mut rect = RECT::default();
    if GetWindowRect(parent, &mut rect).is_err() {
        return;
    }
    let (width, height) = caption_metrics(parent);
    let kinds = [
        CaptionButtonKind::Minimize,
        CaptionButtonKind::Maximize,
        CaptionButtonKind::Close,
    ];

    for (index, kind) in kinds.into_iter().enumerate() {
        let Some(child) = get_caption_button(parent, kind) else {
            continue;
        };
        let x = rect.right - width * (3 - index as i32);
        let _ = SetWindowPos(
            child,
            Some(HWND_TOP),
            x,
            rect.top,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        if let Err(error) = render_layered_caption_button(child, kind) {
            eprintln!("[Windows titlebar] Failed to render {kind:?}: {error}");
        }
    }
}
unsafe fn hit_test_caption_buttons(hwnd: HWND, lparam: LPARAM) -> Option<LRESULT> {
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_err() {
        return None;
    }
    let (width, height) = caption_metrics(hwnd);
    let x = signed_low_word(lparam.0);
    let y = signed_high_word(lparam.0);
    if y < rect.top || y >= rect.top + height || x < rect.right - width * 3 || x >= rect.right {
        return None;
    }
    let slot = (x - (rect.right - width * 3)) / width;
    let hit = match slot {
        0 => HTMINBUTTON,
        1 => HTMAXBUTTON,
        2 => HTCLOSE,
        _ => return None,
    };
    Some(LRESULT(hit as isize))
}

unsafe fn update_caption_visual_state(parent: HWND, hit: u32, flag: isize, enabled: bool) {
    let target = CaptionButtonKind::from_hit_test(hit);
    for kind in [CaptionButtonKind::Minimize, CaptionButtonKind::Maximize, CaptionButtonKind::Close] {
        if let Some(child) = get_caption_button(parent, kind) {
            update_button_state(child, kind, flag, enabled && target == Some(kind));
        }
    }
}

unsafe fn clear_caption_visual_state(parent: HWND, flag: isize) {
    for kind in [CaptionButtonKind::Minimize, CaptionButtonKind::Maximize, CaptionButtonKind::Close] {
        if let Some(child) = get_caption_button(parent, kind) {
            update_button_state(child, kind, flag, false);
        }
    }
}
unsafe fn hit_test_resize_border(hwnd: HWND, lparam: LPARAM) -> Option<LRESULT> {
    if IsZoomed(hwnd).as_bool() {
        return None;
    }

    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_err() {
        return None;
    }

    let dpi = GetDpiForWindow(hwnd);
    let padded = GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
    let frame_x = GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi) + padded;
    let frame_y = GetSystemMetricsForDpi(SM_CYSIZEFRAME, dpi) + padded;
    let x = signed_low_word(lparam.0);
    let y = signed_high_word(lparam.0);
    let left = x >= rect.left && x < rect.left + frame_x;
    let right = x < rect.right && x >= rect.right - frame_x;
    let top = y >= rect.top && y < rect.top + frame_y;
    let bottom = y < rect.bottom && y >= rect.bottom - frame_y;

    let hit = match (left, right, top, bottom) {
        (true, _, true, _) => HTTOPLEFT,
        (_, true, true, _) => HTTOPRIGHT,
        (true, _, _, true) => HTBOTTOMLEFT,
        (_, true, _, true) => HTBOTTOMRIGHT,
        (true, _, _, _) => HTLEFT,
        (_, true, _, _) => HTRIGHT,
        (_, _, true, _) => HTTOP,
        (_, _, _, true) => HTBOTTOM,
        _ => return None,
    };

    Some(LRESULT(hit as isize))
}
unsafe fn maximize_into_work_area(params: &mut NCCALCSIZE_PARAMS) {
    let monitor = MonitorFromRect(&params.rgrc[0], MONITOR_DEFAULTTONEAREST);
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if GetMonitorInfoW(monitor, &mut info).as_bool() {
        params.rgrc[0] = info.rcWork;
    }
}

unsafe fn render_caption_buttons(parent: HWND) {
    for kind in [
        CaptionButtonKind::Minimize,
        CaptionButtonKind::Maximize,
        CaptionButtonKind::Close,
    ] {
        if let Some(child) = get_caption_button(parent, kind) {
            if let Err(error) = render_layered_caption_button(child, kind) {
                eprintln!("[Windows titlebar] Failed to render {kind:?}: {error}");
            }
        }
    }
}

unsafe fn destroy_caption_buttons(parent: HWND) {
    for kind in [
        CaptionButtonKind::Minimize,
        CaptionButtonKind::Maximize,
        CaptionButtonKind::Close,
    ] {
        if let Some(child) = get_caption_button(parent, kind) {
            let _ = RemovePropW(parent, kind.prop_name());
            let _ = DestroyWindow(child);
        }
    }
}

unsafe extern "system" fn custom_frame_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    _ref_data: usize,
) -> LRESULT {
    match message {
        WM_NCCALCSIZE if wparam.0 != 0 => {
            let params = &mut *(lparam.0 as *mut NCCALCSIZE_PARAMS);
            if IsZoomed(hwnd).as_bool() {
                maximize_into_work_area(params);
            }
            LRESULT(0)
        }
        WM_NCHITTEST => hit_test_caption_buttons(hwnd, lparam)
            .or_else(|| hit_test_resize_border(hwnd, lparam))
            .unwrap_or_else(|| DefSubclassProc(hwnd, message, wparam, lparam)),
        WM_NCMOUSEMOVE => {
            update_caption_visual_state(hwnd, wparam.0 as u32, BUTTON_STATE_HOVER, true);
            track_button_leave(hwnd, true);
            DefSubclassProc(hwnd, message, wparam, lparam)
        }
        WM_NCMOUSELEAVE => {
            clear_caption_visual_state(hwnd, BUTTON_STATE_HOVER);
            clear_caption_visual_state(hwnd, BUTTON_STATE_PRESSED);
            DefSubclassProc(hwnd, message, wparam, lparam)
        }
        WM_NCLBUTTONDOWN => {
            update_caption_visual_state(hwnd, wparam.0 as u32, BUTTON_STATE_PRESSED, true);
            DefSubclassProc(hwnd, message, wparam, lparam)
        }
        WM_NCLBUTTONUP => {
            clear_caption_visual_state(hwnd, BUTTON_STATE_PRESSED);
            if let Some(kind) = CaptionButtonKind::from_hit_test(wparam.0 as u32) {
                let command = kind.system_command(hwnd);
                let _ = PostMessageW(Some(hwnd), WM_SYSCOMMAND, WPARAM(command as usize), LPARAM(0));
                LRESULT(0)
            } else {
                DefSubclassProc(hwnd, message, wparam, lparam)
            }
        }
        WM_SIZE | WM_WINDOWPOSCHANGED | WM_DPICHANGED => {
            reposition_caption_buttons(hwnd);
            DefSubclassProc(hwnd, message, wparam, lparam)
        }
        WM_THEMECHANGED | WM_SETTINGCHANGE | WM_NCACTIVATE => {
            render_caption_buttons(hwnd);
            DefSubclassProc(hwnd, message, wparam, lparam)
        }
        WM_NCDESTROY => {
            destroy_caption_buttons(hwnd);
            DefSubclassProc(hwnd, message, wparam, lparam)
        }
        _ => DefSubclassProc(hwnd, message, wparam, lparam),
    }
}

fn install_custom_frame<R: Runtime>(window: &Window<R>) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;

    unsafe {
        let corner_preference = DWMWCP_ROUND;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &corner_preference as *const _ as *const core::ffi::c_void,
            size_of::<windows::Win32::Graphics::Dwm::DWM_WINDOW_CORNER_PREFERENCE>() as u32,
        );

        if !SetWindowSubclass(hwnd, Some(custom_frame_proc), RISU_FRAME_SUBCLASS_ID, 0).as_bool() {
            return Err("SetWindowSubclass failed for custom frame".to_string());
        }

        for kind in [
            CaptionButtonKind::Minimize,
            CaptionButtonKind::Maximize,
            CaptionButtonKind::Close,
        ] {
            create_caption_button(hwnd, kind)?;
        }
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        )
        .map_err(|error| format!("SetWindowPos(frame changed) failed: {error}"))?;

        reposition_caption_buttons(hwnd);
    }

    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("windows-titlebar")
        .on_window_ready(|window| {
            if !supports_custom_frame(window.label()) {
                return;
            }
            let label = window.label().to_string();
            if let Err(error) = install_custom_frame(&window) {
                eprintln!("[Windows titlebar] Failed to extend client area for {label}: {error}");
            } else {
            }
        })
        .build()
}
