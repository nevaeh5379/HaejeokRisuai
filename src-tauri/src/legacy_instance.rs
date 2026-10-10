//! Reserve the exact singleton used by tauri-plugin-single-instance 2.4.4
//! (https://github.com/tauri-apps/plugins-workspace, single-instance-v2.4.4).
//! This must also stop an old executable launched while migration is running.
use std::io;

pub enum LockError {
    Running,
    Other(io::Error),
}

#[cfg(target_os = "linux")]
pub struct LegacyInstance {
    _connection: zbus::blocking::Connection,
}

#[cfg(target_os = "linux")]
struct LegacyDbus;

#[cfg(target_os = "linux")]
#[zbus::interface(name = "org.SingleInstance.DBus")]
impl LegacyDbus {
    fn execute_callback(&self, _argv: Vec<String>, _cwd: String) {
        // Acknowledge old launches without applying their deep links to the
        // migration process. The old plugin exits after this reply.
    }
}

#[cfg(target_os = "linux")]
impl LegacyInstance {
    pub fn acquire() -> Result<Self, LockError> {
        let result = zbus::blocking::connection::Builder::session()
            .and_then(|builder| builder.name("co.aiclient.risu.SingleInstance"))
            .and_then(|builder| builder.serve_at("/co/aiclient/risu/SingleInstance", LegacyDbus))
            .and_then(|builder| {
                builder
                    .replace_existing_names(false)
                    .allow_name_replacements(false)
                    .build()
            });
        match result {
            Ok(connection) => Ok(Self {
                _connection: connection,
            }),
            Err(zbus::Error::NameTaken) => Err(LockError::Running),
            Err(e) => Err(LockError::Other(io::Error::other(e.to_string()))),
        }
    }
}

#[cfg(target_os = "macos")]
pub struct LegacyInstance {
    _listener: std::os::unix::net::UnixListener,
}

#[cfg(target_os = "macos")]
const SOCKET: &str = "/tmp/co_aiclient_risu_si.sock";

#[cfg(target_os = "macos")]
impl LegacyInstance {
    pub fn acquire() -> Result<Self, LockError> {
        use std::os::unix::net::{UnixListener, UnixStream};
        match UnixListener::bind(SOCKET) {
            Ok(listener) => Ok(Self {
                _listener: listener,
            }),
            Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
                // Connecting only probes the socket; it sends no deep-link args.
                match UnixStream::connect(SOCKET) {
                    Ok(_) => Err(LockError::Running),
                    Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => {
                        std::fs::remove_file(SOCKET).map_err(LockError::Other)?;
                        UnixListener::bind(SOCKET)
                            .map(|listener| Self {
                                _listener: listener,
                            })
                            .map_err(LockError::Other)
                    }
                    Err(e) => Err(LockError::Other(e)),
                }
            }
            Err(e) => Err(LockError::Other(e)),
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for LegacyInstance {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(SOCKET);
    }
}

#[cfg(target_os = "windows")]
pub struct LegacyInstance {
    window: isize,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(target_os = "windows")]
mod windows_lock {
    use super::*;
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HWND, LPARAM, LRESULT, WPARAM,
        },
        System::{
            LibraryLoader::GetModuleHandleW,
            Threading::{CreateMutexW, ReleaseMutex},
        },
        UI::WindowsAndMessaging::*,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        match msg {
            // The old plugin exits after sending its args to this hidden target.
            WM_COPYDATA => 1,
            WM_CLOSE => {
                unsafe {
                    DestroyWindow(hwnd);
                }
                0
            }
            WM_DESTROY => {
                unsafe {
                    PostQuitMessage(0);
                }
                0
            }
            _ => unsafe { DefWindowProcW(hwnd, msg, wp, lp) },
        }
    }

    impl LegacyInstance {
        pub fn acquire() -> Result<Self, LockError> {
            Self::acquire_named("co.aiclient.risu")
        }

        fn acquire_named(identifier: &str) -> Result<Self, LockError> {
            let (send, receive) = std::sync::mpsc::sync_channel(1);
            let identifier = identifier.to_owned();
            // The target needs a message loop: a mutex alone is insufficient
            // because the old plugin proceeds when FindWindowW returns null.
            let thread = std::thread::spawn(move || unsafe {
                let mutex_name = wide(&format!("{identifier}-sim"));
                let mutex = CreateMutexW(std::ptr::null(), 1, mutex_name.as_ptr());
                if mutex.is_null() {
                    let _ = send.send(Err(LockError::Other(io::Error::last_os_error())));
                    return;
                }
                if GetLastError() == ERROR_ALREADY_EXISTS {
                    CloseHandle(mutex);
                    let _ = send.send(Err(LockError::Running));
                    return;
                }
                let class_name = wide(&format!("{identifier}-sic"));
                let window_name = wide(&format!("{identifier}-siw"));
                let instance = GetModuleHandleW(std::ptr::null());
                let class = WNDCLASSW {
                    lpfnWndProc: Some(window_proc),
                    hInstance: instance,
                    lpszClassName: class_name.as_ptr(),
                    ..std::mem::zeroed()
                };
                if RegisterClassW(&class) == 0 {
                    let failure = io::Error::last_os_error();
                    ReleaseMutex(mutex);
                    CloseHandle(mutex);
                    let _ = send.send(Err(LockError::Other(failure)));
                    return;
                }
                let window = CreateWindowExW(
                    WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                    class_name.as_ptr(),
                    window_name.as_ptr(),
                    WS_POPUP,
                    0,
                    0,
                    0,
                    0,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                if window.is_null() {
                    let failure = io::Error::last_os_error();
                    UnregisterClassW(class_name.as_ptr(), instance);
                    ReleaseMutex(mutex);
                    CloseHandle(mutex);
                    let _ = send.send(Err(LockError::Other(failure)));
                    return;
                }
                if send.send(Ok(window as isize)).is_err() {
                    DestroyWindow(window);
                } else {
                    let mut message = std::mem::zeroed();
                    while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                        TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                UnregisterClassW(class_name.as_ptr(), instance);
                ReleaseMutex(mutex);
                CloseHandle(mutex);
            });
            match receive.recv() {
                Ok(Ok(window)) => Ok(Self {
                    window,
                    thread: Some(thread),
                }),
                result => {
                    let _ = thread.join();
                    match result {
                        Ok(Err(e)) => Err(e),
                        _ => Err(LockError::Other(io::Error::other(
                            "Legacy lock thread failed",
                        ))),
                    }
                }
            }
        }
    }

    impl Drop for LegacyInstance {
        fn drop(&mut self) {
            unsafe {
                PostMessageW(self.window as HWND, WM_CLOSE, 0, 0);
            }
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn legacy_lock_blocks_the_old_plugin_and_is_released_on_drop() {
            let id = format!("migration-test-{}", uuid::Uuid::new_v4());
            let lock = LegacyInstance::acquire_named(&id)
                .unwrap_or_else(|_| panic!("Cannot acquire lock"));
            assert!(matches!(
                LegacyInstance::acquire_named(&id),
                Err(LockError::Running)
            ));
            unsafe {
                let mutex = CreateMutexW(std::ptr::null(), 0, wide(&format!("{id}-sim")).as_ptr());
                assert!(!mutex.is_null());
                assert_eq!(GetLastError(), ERROR_ALREADY_EXISTS);
                CloseHandle(mutex);
                let window = FindWindowW(
                    wide(&format!("{id}-sic")).as_ptr(),
                    wide(&format!("{id}-siw")).as_ptr(),
                );
                assert!(!window.is_null());
                let mut result = 0;
                let payload = b"test-cwd|test-args\0";
                let data = windows_sys::Win32::System::DataExchange::COPYDATASTRUCT {
                    dwData: 1542,
                    cbData: payload.len() as u32,
                    lpData: payload.as_ptr() as _,
                };
                assert_ne!(
                    SendMessageTimeoutW(
                        window,
                        WM_COPYDATA,
                        0,
                        &data as *const _ as isize,
                        SMTO_ABORTIFHUNG,
                        2000,
                        &mut result
                    ),
                    0
                );
                assert_eq!(result, 1);
            }
            drop(lock);
            let _reacquired = LegacyInstance::acquire_named(&id)
                .unwrap_or_else(|_| panic!("Lock was not released"));
        }
    }
}
