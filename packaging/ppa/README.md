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

## Automatic publishing from GitHub Actions

The main `Publish` workflow calls `.github/workflows/ppa-publish.yml` after
the GitHub release has been published. By default it uploads source packages
for both Ubuntu Noble and Resolute with PPA revision `1`.

Each Ubuntu series runs as a separate matrix job, with at most one upload
running at a time. This keeps a failure for one series isolated so GitHub's
"Re-run failed jobs" action does not upload an already successful series
again. Launchpad uploads are retried up to four times with increasing delays
to tolerate transient FTP failures.

The upload workflow needs these GitHub Actions secrets:

- `LAUNCHPAD_GPG_PRIVATE_KEY`: ASCII-armored secret key registered with the
  Launchpad account.
- `LAUNCHPAD_GPG_PASSPHRASE`: passphrase for that key. It may be empty for
  an unprotected CI-only key.

A dedicated Launchpad upload key is recommended instead of a personal signing
key. Register its public key with Launchpad before adding the private key to
GitHub Actions secrets.

If `LAUNCHPAD_GPG_PRIVATE_KEY` is not configured, the automatic PPA step
finishes successfully with a warning and does not upload anything.

The `Publish PPA` workflow can also be started manually. Use a higher
`ppa_revision` when the same application build needs to be repackaged and
uploaded again, for example revision `2` after fixing only the Debian
packaging.

## Build a source upload manually

Prerequisites are Git, GitHub CLI, tar, xz, and Docker or Podman.
A local `dpkg-buildpackage` is used only as a fallback.

From the repository root:

```bash
./packaging/ppa/build-source-package.sh 7376 noble 1
cd dist-ppa/b7376-noble-ppa1
```

Arguments are `<build-number> <ubuntu-series> <ppa-revision>`. If the build
number is omitted, the helper uses the latest GitHub release. The Ubuntu
series defaults to `noble` and the PPA revision defaults to `1`.

The helper intentionally creates an unsigned source upload. Sign the generated
`_source.changes` file with the OpenPGP key registered on Launchpad:

```bash
debsign -k<fingerprint> \
  haejeok-risuai_0.0.7376-1~ppa1~noble1_source.changes
```

On systems whose `dput` does not understand the `ppa:` shorthand, add a
host entry such as this to `~/.dput.cf`:

```ini
[haejeok-risuai]
fqdn = ppa.launchpad.net
method = ftp
incoming = ~nevaeh5379/ubuntu/haejeok-risuai/
login = anonymous
passive_ftp = 1
allow_unsigned_uploads = 0
```

Then upload the signed source package from the same output directory:

```bash
dput haejeok-risuai \
  haejeok-risuai_0.0.7376-1~ppa1~noble1_source.changes
```
