> This document was translated using Google Translate. Please refer to the original document [here](./README.md).

# HaejeokRisuai

<img width="100%" src="./public/logo_typo.svg"/>

HaejeokRisuai is a fork of the [Risuai](https://github.com/kwaroran/Risuai) repository.

## Features

- Traffic/Memory Optimization

The database structure has been redesigned to fetch only the necessary data.

- Additional convenience features
- Ease of use/Accessibility

It supports cross-platform usage to ensure accessibility for everyone. Windows, macOS, and Linux are supported via Tauri, while Android builds are distributed as APKs using Capacitor.

UI improvements are also currently underway.

## Web Access
You can use HaejeokRisuai immediately by visiting [risuai.dev](https://risuai.dev). It utilizes `sqlite-wasm` for the database.

## Installation

### Using installation files from GitHub Releases (macOS, Linux, Windows, Android)

You can find the latest build versions at [this link](https://github.com/nevaeh5379/HaejeokRisuai/releases/tag/b7476).

Support for arm64 and amd64 architectures is available for macOS, Linux, and Windows.
Android supports arm64 only. ### Installation via PPA (Debian-based systems)

1. Register the repository

`sudo add-apt-repository ppa:nevaeh5379/haejeok-risuai`

2. Update the repository

`sudo update`

3. Install Haejeok-Risuai

`sudo apt install haejeok-risuai`

Script:
```bash
sudo add-apt-repository ppa:nevaeh5379/haejeok-risuai
sudo update
sudo apt install haejeok-risuai
```

### Launching the server using Termux
Please refer to the [Termux deployment guide](https://github.com/nevaeh5379/HaejeokRisuai/blob/main/deploy/termux/README.ko.md) for detailed instructions.

1. Update packages

`pkg update`

2. Install Haejeok-Risuai

`curl -fsSL https://raw.githubusercontent.com/nevaeh5379/HaejeokRisuAI/main/deploy/termux/install.sh | bash`

This will also install Node.js and PostgreSQL.

3. Start the Haejeok-Risuai service

`haejeok open`

Your browser will open automatically.

### Installation via cloning (git clone)

Currently, support is available only for Linux and macOS. There is no dedicated script for Windows yet.

**Docker** or **podman** is required.

1. Clone the repository

`git clone https://github.com/nevaeh5379/HaejeokRisuai.git`

2. Install using `risuai.sh`
`./risuai.sh install`

The server will start automatically once installation is complete.

### Other (WIP)

Documentation is currently in progress. ## Compatibility

It is compatible with databases backed up from the original [Risu](https://github.com/kwaroran/Risuai) and supports Plugin API V3.

If you encounter errors during restoration or experience plugin-related compatibility issues, please submit an [issue](https://github.com/nevaeh5379/HaejeokRisuai/issues).

The following features are not supported or provided:
- Risu account integration
- Plugin v2.0
- Plugin v2.1

## Pull Requests (PRs)
There are currently no restrictions regarding PRs. AI-generated code is also permitted.

## Terms
- [HaejeokRisuai TERMS](https://github.com/nevaeh5379/HaejeokRisuai/blob/main/docs/TERMS.md)
- [HaejeokRisuai PRIVACY](https://github.com/nevaeh5379/HaejeokRisuai/blob/main/docs/PRIVACY.md)
- [Upstream Risu Terms of Service](https://sv.risuai.xyz/hub/tos)
- [RisuRealm Content Rules](https://realm.risuai.net/help/content-rules)

RisuRealm and Risu account services are managed by the upstream Risu developers; we are not involved in their operation. HaejeokRisu does not provide Risu account services.