# Android E2E tests

These tests drive the packaged Capacitor application on an Android emulator or
USB-connected device. Appium controls Android through UiAutomator2 and then
switches into the app's real WebView, so Android-only storage, lifecycle, and
plugin behaviour is present during the test.

## Prerequisites

- A Node.js version allowed by the root `package.json`
- JDK and Android SDK. The runner detects `java` from `PATH` and reads
  `android/local.properties`; explicit `JAVA_HOME`, `ANDROID_HOME`, or
  `ANDROID_SDK_ROOT` values take precedence.
- An emulator or USB-debuggable device visible as `device` in `adb devices`
- Project dependencies installed with `pnpm install --frozen-lockfile`

Check the native automation prerequisites with:

```bash
pnpm test:e2e:android:doctor
```

## Run

Start an emulator, then run:

```bash
pnpm test:e2e:android
```

The command builds the debug APK, starts a project-local Appium server, runs
every `android-e2e/*.test.ts` file, and stops the server. Logs and failure
screenshots are written to the ignored `android-e2e/artifacts/` directory.
Each session force-installs the selected APK so an already-installed build with
the same Android version cannot make the test run stale code.
The E2E build also installs a deterministic globally enabled legacy
module/chat fixture, persists it,
reloads the app, and verifies that the restored chat can run its module action
and open the chat module menu after selecting the character through the real
default Android UI. This fixture is only enabled for builds created by
`test:e2e:android` (`VITE_ANDROID_E2E=TRUE`). Tests run serially because one
emulator cannot safely host multiple Appium sessions at once.
On the first WebView run, Appium downloads a Chromedriver matching the device's
WebView and caches it under `android-e2e/artifacts/chromedrivers/`. Later runs
reuse that binary. The server listens only on `127.0.0.1`, and only the scoped
UiAutomator2 Chromedriver-download feature is enabled.

For a previously built APK:

```bash
ANDROID_E2E_SKIP_BUILD=1 pnpm test:e2e:android
```

The reused APK must have been built by a previous `test:e2e:android` run so it
contains the E2E-only fixture hook.

Useful overrides:

| Variable                       | Purpose                                                  |
| ------------------------------ | -------------------------------------------------------- |
| `ANDROID_E2E_APK`              | APK path relative to the repository, or an absolute path |
| `ANDROID_E2E_UDID`             | Select one device when more than one is connected        |
| `ANDROID_E2E_DEVICE_NAME`      | Appium device name; defaults to `Android`                |
| `ANDROID_E2E_APPIUM_PORT`      | Appium port; defaults to `4723`                          |
| `ANDROID_E2E_WDIO_LOG_LEVEL`   | WebdriverIO log level; defaults to `warn`                |
| `ANDROID_E2E_CHROMEDRIVER_DIR` | Persistent directory for matching Chromedriver binaries  |

The initial smoke test deliberately verifies the real Capacitor origin and
native-platform flag after switching into the WebView. Android-specific
regressions should be added as separate test files and should assert visible
user behaviour rather than only reading an internal store.
