# Haejeok RisuAI

<picture>
  <img alt="Haejeok RisuAI" src="./public/logo_typo_small.avif" width="400"/>
</picture>

[![Svelte](https://img.shields.io/badge/svelte-5-red?logo=svelte)](https://svelte.dev/) [![TypeScript](https://img.shields.io/badge/typescript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/) [![Tauri](https://img.shields.io/badge/tauri-2.5-%2324C8D8?logo=tauri)](https://tauri.app/) [![Vite](https://img.shields.io/badge/vite-8-%23646CFF?logo=vite)](https://vite.dev/) [![Tailwind CSS](https://img.shields.io/badge/tailwindcss-4-%2306B6D4?logo=tailwindcss)](https://tailwindcss.com/)

**Haejeok RisuAI** is an independently maintained fork of [RisuAI](https://github.com/kwaroran/RisuAI), focused on self-hosting, server-side operation, desktop distribution, and maintaining a practical deployment path for personal infrastructure.

It keeps the core RisuAI chat experience while developing and distributing Haejeok-specific changes independently from the upstream project.

> [!IMPORTANT]
> Haejeok RisuAI is not an official RisuAI release. Bugs, releases, deployment support, and project-specific changes should be reported here rather than to the upstream project.

## Project status

Haejeok RisuAI is currently an actively developed independent build. The primary server deployment path being tested and documented is **Docker + PostgreSQL + RustFS**. Other deployment modes may exist in the repository but should be treated as less tested unless explicitly documented.

## What is different?

- Independent GitHub releases and desktop updater
- Independent Docker/OCI image distribution
- PostgreSQL-backed server storage
- RustFS S3-compatible asset storage support
- Self-hosting and Node server improvements
- `bNNNN` build numbering based on Git history
- No built-in Risu Account login or account synchronization
- RisuRealm is treated as an external upstream service and keeps its own authentication, terms, and content rules

## Q&A

Q. Does it run on the Galaxy S2?

A. No

Q. Does it run on Power Mac?

A. No

Q. Does it run on the Samsung Omnia series?

A. No

Q. Does it run on the LG Optimus series?

A. No

Q. Does it run on the iPhone 3GS?

A. No

Q. Does it run on Windows 98/95?

A. No

Q. Does it run on the Intel 80486?

A. No

Q. Does it run on the Compaq Deskpro?

A. No

Q. Does it run on the Tandy 1000?

A. No

Q. Does it run on the Anycall series?

A. No

Q. Does it run on the Intel 4004?

A. No

## Core features

Haejeok RisuAI inherits the broad feature set of RisuAI, including:

- Multiple AI API providers such as OpenAI, Claude, Gemini, OpenRouter, and compatible endpoints
- Character cards, group chats, lorebooks, regex scripts, plugins, and custom prompting
- Emotion images, additional assets, TTS, translation, and theming
- Long-term memory systems including HypaMemory and SupaMemory
- Web, Node server, and Tauri desktop targets

## Screenshots

The screenshots below are inherited upstream UI references and may not exactly match the latest Haejeok RisuAI build.

|         Screenshot 1         |         Screenshot 2         |
| :--------------------------: | :--------------------------: |
| ![Screenshot 1][screenshot1] | ![Screenshot 2][screenshot2] |
| ![Screenshot 3][screenshot3] | ![Screenshot 4][screenshot4] |

[screenshot1]: https://github.com/kwaroran/Risuai/assets/116663078/cccb9b33-5dbd-47d7-9c85-61464790aafe
[screenshot2]: https://github.com/kwaroran/Risuai/assets/116663078/30d29f85-1380-4c73-9b82-1a40f2c5d2ea
[screenshot3]: https://github.com/kwaroran/Risuai/assets/116663078/faad0de5-56f3-4176-b38e-61c2d3a8698e
[screenshot4]: https://github.com/kwaroran/Risuai/assets/116663078/ef946882-2311-43e7-81e7-5ca2d484fa90

## Installation

### Desktop releases

Prebuilt desktop releases are published through the [Haejeok RisuAI Releases](https://github.com/nevaeh5379/HaejeokRisuAI/releases) page.

Linux releases are provided in several formats:

- `.deb` — Debian, Ubuntu, Linux Mint, Pop!_OS, and other Debian-based distributions (`sudo apt install ./<package>.deb`)
- `.rpm` — Fedora, RHEL, Rocky Linux, AlmaLinux, and other RPM-based distributions (`sudo dnf install ./<package>.rpm`); openSUSE users can use `sudo zypper install ./<package>.rpm`
- `.pkg.tar.zst` — Arch Linux, Manjaro, EndeavourOS, CachyOS, and other Arch-based distributions (`sudo pacman -U ./<package>.pkg.tar.zst`)
- `.AppImage` — portable fallback for other compatible glibc-based Linux distributions (`chmod +x <package>.AppImage && ./<package>.AppImage`)

Both x86_64 and ARM64 Linux builds are published.

### Docker server (recommended)

The recommended server path uses the prebuilt Docker image with **PostgreSQL 17 + RustFS + restic**.

#### Requirements

- Docker Engine or Docker Desktop
- Docker Compose v2 (`docker compose`)
- `curl`

#### One-line install

```sh
curl -fsSL https://raw.githubusercontent.com/nevaeh5379/HaejeokRisuAI/main/install.sh | sh
```

The installer creates `~/haejeok-risuai`, generates random credentials, downloads the quick Compose stack, pulls `ubfaole9/risuai:latest`, and starts the services. After installation, open `http://localhost:6001`.

The installer configures:

- Haejeok RisuAI from `ubfaole9/risuai:latest`
- PostgreSQL 17 (`postgres:17-alpine`)
- RustFS S3-compatible object storage
- restic for encrypted snapshots

PostgreSQL stays inside the Docker network. RustFS is bound to loopback by default (`127.0.0.1:9000` for the S3 API and `127.0.0.1:9001` for the console).

#### Managing and backing up the server

```sh
cd ~/haejeok-risuai
docker compose ps
docker compose logs -f risuai
./backup.sh
docker compose pull && docker compose up -d
```

The backup helper briefly quiesces application writes, creates a PostgreSQL `pg_dump`, stops RustFS while its volume is read, and stores the database dump, RustFS data, and `save/` state in restic. The default encrypted restic repository is local under `backup/restic`, so configure or copy it off-host for real disaster recovery and keep the `RESTIC_PASSWORD` separately.

See the [quick deployment guide](deploy/quick/README.md) for backup details and remote restic configuration.

#### Advanced/source installation

The full `risuai.sh` installer remains available for Node/server or browser-only static source builds and `lan`, `domain`, `dynv6`, and external reverse-proxy modes:

```sh
git clone https://github.com/nevaeh5379/HaejeokRisuAI.git
cd HaejeokRisuAI
./risuai.sh install --mode local -y

# Static web build served by Caddy, without Node/PostgreSQL/RustFS
./risuai.sh install --runtime static --mode local -y
```

See the [advanced deployment guide](deploy/rustfs/README.md) for those modes and their security notes.

### Development

Development requires Node.js 20.19+ or 22.12+ and pnpm.

```sh
git clone https://github.com/nevaeh5379/HaejeokRisuAI.git
cd HaejeokRisuAI
pnpm install
pnpm dev
```

## Legal and upstream services

- [Haejeok RisuAI Terms of Use](docs/TERMS.md)
- [Haejeok RisuAI Privacy Notice](docs/PRIVACY.md)
- [Original RisuAI service terms](https://sv.risuai.xyz/hub/tos)
- [RisuRealm Content Rules](https://realm.risuai.net/help/content-rules)

Haejeok RisuAI does not provide built-in Risu Account login or account synchronization. RisuRealm and other upstream-hosted services remain separate services operated by the original RisuAI maintainers and are subject to their own policies.

## Community and support

For Haejeok RisuAI bugs, deployment issues, and project-specific feature requests, use the [Haejeok RisuAI issue tracker](https://github.com/nevaeh5379/HaejeokRisuAI/issues).

The upstream RisuAI Discord server, website, and support channels are not Haejeok RisuAI support channels.

## Upstream project

Haejeok RisuAI is based on [RisuAI](https://github.com/kwaroran/RisuAI) and retains its Git history and GPL-3.0 licensed source heritage.

Upstream development, documentation, and community resources belong to the original RisuAI project. Haejeok-specific releases and changes are maintained independently in this repository.

If a change is suitable for the original project as well, contributions can still be prepared separately for upstream RisuAI.

## License

This project is distributed under the repository's [GNU General Public License v3.0](LICENSE).
