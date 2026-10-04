# Pinned Linux AppImage WebKitGTK

`webkitgtk-version.json` pins the upstream source version and SHA-256 checksum.
The Linux release jobs build that source on Ubuntu 22.04, stage the installation,
and cache it by architecture and build configuration. The source URL is versioned;
the mutable `webkitgtk-stable.tar.xz` alias is never used.

The staged installation replaces the runner's WebKitGTK development and runtime
files before Tauri packages the AppImage. GTK 3 / libsoup 3 (API 4.1) is retained.
JPEG XL is disabled because Ubuntu 22.04 does not provide the required libjxl
version, matching the previous AppImage's lack of a libjxl dependency.
Documentation, introspection data, MiniBrowser, and WebDriver are not built.
GCC 14 comes from the Ubuntu Toolchain team's PPA; GCC 12 rejects an assertion
in the bundled ANGLE source. The runtime is still built against Ubuntu 22.04's
glibc. The workflow explicitly includes `libstdc++.so.6` and `libgcc_s.so.1`,
which linuxdeploy otherwise excludes, so older hosts can load the new engine.

`verify-webkitgtk.ts` checks both WebKitGTK and JavaScriptCore through their native
version APIs. After packaging, it also compares ELF build IDs against the staged
installation for the libraries, injected bundle, and subprocesses, including the
GPU process. This catches mixed installations while allowing
linuxdeploy's RPATH relocation. An incorrect bundle fails the release job before
the draft release can be published.

To update WebKitGTK, change **both** the version and its checksum in the pin file.
The upstream checksum is available at
`https://webkitgtk.org/releases/webkitgtk-VERSION.tar.xz.sums`.
The cache key changes automatically; the first build for each architecture will
compile WebKitGTK again. Cached builds still undergo runtime verification.

For local Ubuntu builds, install the build dependencies listed in the release
workflow and run:

```sh
WEBKIT_BUILD_DIR=/tmp/risu-webkit-build \
WEBKIT_STAGE_DIR=/tmp/risu-webkit-runtime \
bash tooling/build-webkitgtk.sh
node --import tsx tooling/verify-webkitgtk.ts /tmp/risu-webkit-runtime
```

The pin applies to the Linux release AppImage. Native DEB/RPM/Arch installations
continue to load the distribution's system WebKitGTK at runtime.
