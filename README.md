# Risuai

<picture>
  <img alt="text" src="https://raw.githubusercontent.com/kwaroran/Risuai/refs/heads/main/public/logo_typo_small.avif" width="400"/>
</picture>

[![Svelte](https://img.shields.io/badge/svelte-5-red?logo=svelte)](https://svelte.dev/) [![Typescript](https://img.shields.io/badge/typescript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/) [![Tauri](https://img.shields.io/badge/tauri-2.5-%2324C8D8?logo=tauri)](https://tauri.app/) [![Vite](https://img.shields.io/badge/vite-8-%23646CFF?logo=vite)](https://vite.dev/) [![Tailwind CSS](https://img.shields.io/badge/tailwindcss-4-%2306B6D4?logo=tailwindcss)](https://tailwindcss.com/)

Risuai, or Risu for short, is a cross platform AI chatting software / web application with powerful features such as multiple API support, assets in the chat, regex functions and much more.

# Screenshots

|         Screenshot 1         |         Screenshot 2         |
| :--------------------------: | :--------------------------: |
| ![Screenshot 1][screenshot1] | ![Screenshot 2][screenshot2] |
| ![Screenshot 3][screenshot3] | ![Screenshot 4][screenshot4] |

[screenshot1]: https://github.com/kwaroran/Risuai/assets/116663078/cccb9b33-5dbd-47d7-9c85-61464790aafe
[screenshot2]: https://github.com/kwaroran/Risuai/assets/116663078/30d29f85-1380-4c73-9b82-1a40f2c5d2ea
[screenshot3]: https://github.com/kwaroran/Risuai/assets/116663078/faad0de5-56f3-4176-b38e-61c2d3a8698e
[screenshot4]: https://github.com/kwaroran/Risuai/assets/116663078/ef946882-2311-43e7-81e7-5ca2d484fa90

## Features

- **Multiple API Supports**: Supports OpenAI, Claude, Gemini, DeepInfra, Ooba, OpenRouter... and More!
- **Emotion Images**: Display the image of the current character, according to his/her expressions!
- **Group Chats**: Multiple characters in one chat.
- **Plugins**: Add your features and providers, and simply share.
- **Regex Script**: Modify model's output by regex, to make a custom GUI and others
- **Powerful Translators**: Automatically translate the input/output, so you can roleplay without knowing model's language.
- **Lorebook**: Also known as world infos or memory book, which can make character memorize more. 
- **Themes**: Choose it from 3 themes, Classic, WaifuLike, WaifuCut.
- **Powerful Prompting**: Change the prompting order easily, Impersonate inside prompts, Use conditions, variables... and more!
- **Customizable, Friendly UI**: Great Accessibility and mobile friendly
- **TTS**: Use TTS to make the output text into voice.
- **Additional Assets**: Embed your images, audios and videos to bot, and make it display at chat or background!
- **Long-term Memory**: Advanced memory systems including HypaMemoryV2/V3 memory compression, SupaMemory for context management to maintain long-term conversation context.
- And More!

You can get detailed information on https://github.com/kwaroran/Risuai/wiki (Work in Progress)

## Community

- [Discord Server](https://discord.gg/JzP8tB9ZK8)

## Legal

- [Haejeok RisuAI Terms of Use](docs/TERMS.md)
- [Haejeok RisuAI Privacy Notice](docs/PRIVACY.md)

Haejeok RisuAI is an independent fork and does not provide built-in Risu Account login or
account synchronization. RisuRealm and related upstream services are operated separately;
when using them, review the [original RisuAI service terms](https://sv.risuai.xyz/hub/tos)
and the [RisuRealm Content Rules](https://realm.risuai.net/help/content-rules).

## Installation

- [Risuai Website](https://risuai.net) (Recommended)
- [Github Releases](https://github.com/kwaroran/Risuai/releases)

### Development prerequisites

- Node.js 20.19+ or 22.12+
- pnpm

### Docker Installation

The recommended server deployment for Haejeok RisuAI is the Docker Compose stack with
**PostgreSQL 17** for persistent application data and **RustFS** for S3-compatible asset
storage. This is the primary deployment path currently documented here.

#### Requirements

- Docker Engine or Docker Desktop
- Docker Compose v2 (`docker compose`)
- Git

#### Quick start (local)

```sh
git clone https://github.com/nevaeh5379/HaejeokRisuAI.git
cd HaejeokRisuAI
chmod +x risuai.sh
./risuai.sh install --mode local -y
```

When the installation finishes, open `http://localhost:6001`.

The installer creates and manages the complete stack:

- Haejeok RisuAI application container
- PostgreSQL 17 (`postgres:17-alpine`)
- RustFS S3-compatible object storage

PostgreSQL is kept inside the Docker network and is not published to the host. RustFS
uses loopback-only host bindings by default (`127.0.0.1:9000` for the S3 API and
`127.0.0.1:9001` for the console).

#### Managing the installation

```sh
./risuai.sh status
./risuai.sh doctor
./risuai.sh logs --follow
./risuai.sh stop
./risuai.sh start
./risuai.sh restart
```

Persistent data is stored in Docker volumes for PostgreSQL and RustFS, while application
state is stored under `./save`. Installer-generated credentials and deployment state are
kept under `.risuai/`; back these up together with your database and RustFS data.

Additional `lan`, `domain`, `dynv6`, and external reverse-proxy modes are available through
`./risuai.sh install`, but the local Docker + PostgreSQL + RustFS setup above is the
recommended starting point. See the [deployment guide](deploy/rustfs/README.md) for the
advanced modes and security notes.
