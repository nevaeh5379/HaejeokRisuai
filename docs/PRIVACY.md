# Haejeok RisuAI Privacy Notice

Effective date: 2026-08-23

This notice describes privacy considerations for Haejeok RisuAI builds and the recommended
self-hosted deployment. Haejeok RisuAI is an independent community fork and is not the
operator of the original RisuAI online services.

## 1. Self-hosted data

Haejeok RisuAI is primarily distributed as software. When you run it yourself, application
data is stored on the device or infrastructure controlled by you or your server operator.
In the recommended Docker deployment, persistent data may be stored in PostgreSQL, assets
may be stored in RustFS, and additional state may be stored in the configured save directory.

The Haejeok RisuAI project does not become the operator of a self-hosted database merely
because it distributes the software. Anyone operating an instance for other people is
responsible for their own privacy notice, access controls, retention, and compliance.

## 2. No built-in Risu Account storage

Haejeok RisuAI does not provide built-in Risu Account login, account storage, or account
synchronization. The Haejeok client does not use Risu Account credentials as its application
storage mechanism.

If an external RisuAI-operated page such as RisuRealm asks you to authenticate, that takes
place with the external service and is governed by that service's own policies.

## 3. Server logs

The Node server may write operational information to standard output, including connection
information such as client IP addresses, timestamps, errors, and request-related diagnostics.
Server operators decide how container or host logs are retained, exported, or deleted.

## 4. AI providers and services you choose

When you configure an AI provider, storage provider, or another integration, prompts, files,
model parameters, credentials, or other data may be sent to that provider as required for
the feature you invoke. Haejeok RisuAI does not control how those third parties process data.

Review each provider's privacy policy before enabling it, especially before sending personal,
confidential, regulated, or otherwise sensitive information.

## 5. RisuRealm and upstream services

RisuRealm and related upstream endpoints are operated separately by the original RisuAI
maintainers. When you open or use RisuRealm, the upstream service's own terms and rules apply:

- https://sv.risuai.xyz/hub/tos
- https://realm.risuai.net/help/content-rules

Information submitted directly to those services is handled by their operators rather than
by the Haejeok RisuAI project.

## 6. Local application storage

The application may store preferences, legal acceptance records, cached assets, credentials
for providers you configure, and application state using browser storage, local files, or
platform-specific storage. Removing the application may not remove data held by a separate
self-hosted server or third-party provider.

## 7. Retention and deletion

For self-hosted deployments, the server operator controls retention. Removing data may
require deleting PostgreSQL records, RustFS objects, files in the save directory, backups,
and retained logs. Data submitted to third-party or upstream services must be managed using
those services' own deletion and retention mechanisms.

## 8. Security, changes, and contact

Protect administrative interfaces, database and RustFS credentials, API keys, backups, and
reverse-proxy configuration. No software or network service can guarantee absolute security.

This notice may be updated as the project changes. Material revisions should update the
effective date above. For non-sensitive questions, use the Haejeok RisuAI repository's
maintainer channels and do not post personal data or credentials publicly.

Operators who make a Haejeok RisuAI instance available to other people should publish a
privacy notice appropriate to their own deployment and jurisdiction. This document is a
project-level baseline and is not a substitute for legal advice.
