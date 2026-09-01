# Termux deployment

Haejeok RisuAI can run directly on Android through Termux without Docker.
The Termux runtime uses:

- Node.js LTS from the Termux repository
- A private PostgreSQL cluster bound to `127.0.0.1`
- Local filesystem asset storage under the Haejeok data directory
- `termux-services`/runit for PostgreSQL and the Node server
- A prebuilt Haejeok frontend from the latest GitHub release

## Install

Use a current Termux installation, then run:

```sh
curl -fsSL https://raw.githubusercontent.com/nevaeh5379/HaejeokRisuAI/main/deploy/termux/install.sh | bash
```

The installer starts the server and opens `http://127.0.0.1:6001` when
`termux-open-url` is available.

The default data directory is:

```text
~/.local/share/haejeok-risuai
```
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
