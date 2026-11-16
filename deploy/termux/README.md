# Termux deployment

[English](README.md) | [한국어](README.ko.md)

Haejeok RisuAI can run directly on Android through Termux without Docker.
The Termux runtime uses:

- Node.js 24.12+ from the Termux repository
- A private PostgreSQL cluster bound to `127.0.0.1`
- Local filesystem asset storage under the Haejeok data directory
- `termux-services`/runit for PostgreSQL and the Node server
- A prebuilt Haejeok frontend from the latest GitHub release

## Install

Use a current Termux installation, then run:

```sh
curl -fsSL https://raw.githubusercontent.com/ioshn/HaejeokRisuai_c4/main/deploy/termux/install.sh | bash
```

The installer starts the server and opens `http://127.0.0.1:6001` when
`termux-open-url` is available.

The default data directory is:

```text
~/.local/share/haejeok-risuai
```

## Switch an existing upstream server to this fork

These steps assume a working native Termux installation from
`nevaeh5379/HaejeokRisuai`. Only the installation/update source changes to
`ioshn/HaejeokRisuai_c4`; the runtime setup stays the same. No Git clone or new
database is needed.

First confirm that this fork's latest public release contains
`RisuAI-Termux-<tag>.tar.gz` and its matching `.sha256` file. Do not switch before
the runtime is released.

1. Stop the existing server and back up its data directory. Both commands must
   succeed before continuing.

   ```sh
   haejeok stop
   tar -czf "$HOME/haejeok-before-c4-$(date +%Y%m%d-%H%M%S).tar.gz" \
     -C "${HAEJEOK_TERMUX_HOME:-$HOME/.local/share/haejeok-risuai}" .
   ```

   Keep this backup private: it includes credentials and PostgreSQL data. If you
   use a custom `HAEJEOK_TERMUX_HOME`, keep the same value during the switch.
   Back up any data paths configured outside that directory separately.

2. Run **this fork's installer directly once**, not the existing
   `haejeok update`, which still points to upstream.

   ```sh
   unset HAEJEOK_TERMUX_TAG
   curl -fsSL https://raw.githubusercontent.com/ioshn/HaejeokRisuai_c4/main/deploy/termux/install.sh | bash
   ```

   Like the upstream installer, this also upgrades Termux packages. It reuses
   your existing configuration, data, ports, and LAN settings, replaces the app
   and `haejeok` command, then starts the services. If it reports an error such as
   a PostgreSQL major-version mismatch, resolve that error without deleting or
   reinitializing your existing data directory.

3. Check the services and installed version, then open the existing address.

   ```sh
   haejeok status
   haejeok version
   haejeok open
   ```

   Confirm that your characters, chats, and assets are present. Future
   `haejeok update` commands install this fork's latest release. The existing
   home-screen shortcut still works. For startup failures, use `haejeok logs`
   and `haejeok logs postgres`.

## Commands

```sh
haejeok open             # start services and open the local browser
haejeok start            # start PostgreSQL and the Node server
haejeok stop             # stop both services
haejeok restart
haejeok status
haejeok logs             # Node server log
haejeok logs postgres    # PostgreSQL log
haejeok update           # install the latest released Termux runtime
haejeok doctor
```

The Node server listens only on the phone by default. To allow another device
on the same network to connect:

```sh
haejeok lan on
```

This changes `RISU_HOST` to `0.0.0.0`. Restore localhost-only access with:

```sh
haejeok lan off
```

When LAN mode is enabled, use the phone's LAN IP and the configured app port.
Do not expose the plain HTTP port directly to the public Internet.
## Home-screen shortcut

The installer creates:

```text
~/.shortcuts/Haejeok-RisuAI
```

If Termux:Widget is installed, add that shortcut to the Android home screen.
Tapping it starts the services and opens Haejeok RisuAI in the browser.

## Storage and updates

Application code and persistent data are deliberately separated. Updating the
runtime replaces only `app/`; it preserves:

- `save/`
- the private PostgreSQL cluster
- `config.env`

The installer keeps the previous runtime as `app.previous` until the new server
passes `/api/health`, then removes it.

## Current Termux scope

The minimal Termux runtime is intentionally PostgreSQL + local filesystem only.
S3/RustFS, Azure SQL, Oracle Database, and native `sharp` image processing are
not installed in the Termux runtime dependency set. The regular Docker/server
build remains the appropriate path when those backends are required.
