# Launchpad PPA packaging

This directory contains the helper used to prepare Haejeok RisuAI source
uploads for the Launchpad PPA:

`ppa:nevaeh5379/haejeok-risuai`

Launchpad builds run without relying on npm or crates.io. To keep the PPA
build deterministic, the source package contains the complete Git tag plus
the official amd64 and arm64 `.deb` release payloads. The Debian build step
selects the payload for the current architecture and repackages it as
`haejeok-risuai`.

The resulting PPA package therefore contains the same application binary as
the corresponding GitHub release. Launchpad still performs the final Debian
package build and repository signing.

## Build a source upload

Prerequisites are Git, GitHub CLI, tar, xz, and Docker or Podman.
A local `dpkg-buildpackage` is used only as a fallback.

From the repository root:

```bash
./packaging/ppa/build-source-package.sh 7376 noble
```

If the build number is omitted, the helper uses the latest GitHub release.
Output is written under `dist-ppa/b<build>-<series>/`.

The helper intentionally creates an unsigned source upload. Sign it with the
OpenPGP key registered on Launchpad:

```bash
debsign -k<fingerprint> haejeok-risuai_<version>_source.changes
```

On systems whose `dput` does not understand the `ppa:` shorthand, add a
host entry such as this to `~/.dput.cf`:

```ini
[haejeok-risuai]
fqdn = ppa.launchpad.net
method = ftp
incoming = ~nevaeh5379/ubuntu/haejeok-risuai/
login = anonymous
allow_unsigned_uploads = 0
```

Then upload the signed source package:

```bash
dput haejeok-risuai haejeok-risuai_<version>_source.changes
```
