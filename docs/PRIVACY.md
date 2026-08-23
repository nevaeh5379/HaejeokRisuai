# Haejeok RisuAI Privacy Notice

Effective date: 2026-08-23

This notice describes privacy considerations for Haejeok RisuAI builds and the project's
recommended self-hosted deployment. Haejeok RisuAI is an independent community fork of
RisuAI and is not the operator of the original RisuAI online services.

## 1. Self-hosted data

Haejeok RisuAI is primarily distributed as software. When you run it yourself, application
data is stored on the device or infrastructure controlled by you or your server operator.
In the recommended Docker deployment, persistent application data may be stored in
PostgreSQL, assets may be stored in RustFS, and additional application state is stored in
the configured save directory.

The Haejeok RisuAI project does not become the controller of a self-hosted database merely
because it distributes the software. The person or organization operating a public instance
is responsible for its own privacy notices, access controls, retention, and compliance.

## 2. Server logs

The Node server may write operational information to standard output, including connection
information such as client IP addresses, timestamps, errors, and request-related diagnostics.
Server operators decide how container or host logs are retained, exported, or deleted.

## 3. Data sent to services you choose

When you configure an AI provider, cloud storage, authentication provider, or another
integration, prompts, files, account information, model parameters, or other data may be
sent to that provider as required for the feature you invoke. Haejeok RisuAI does not
control how those third parties process data.

Review the privacy policy of each provider before enabling it, especially before sending
personal, confidential, regulated, or otherwise sensitive information.

## 4. Original RisuAI online services

Optional features may connect to services operated by the original RisuAI maintainers,
including RisuAI account, Hub, Realm, and related endpoints. Those services are separate
from Haejeok RisuAI. Their own Terms of Service and Privacy Policy govern information sent
to them.

Haejeok RisuAI presents a separate upstream-service notice before supported account,
Hub, or Realm flows so that this distinction is visible to users.

## 5. Browser and application storage

The application may store preferences, acceptance records, cached assets, credentials,
and application state using browser storage, local files, or platform-specific application
storage. Deleting the application alone may not remove server-side or third-party data.

## 6. Retention and deletion

For self-hosted deployments, the server operator controls retention. Removing data may
require deleting records from PostgreSQL, objects from RustFS, files in the save directory,
backups, and retained logs. Data previously sent to third-party services must be managed
under those services' own deletion and retention mechanisms.

## 7. Security

No software or network service can guarantee absolute security. Protect administrative
interfaces, database credentials, RustFS credentials, API keys, backups, and reverse-proxy
configuration. Do not expose PostgreSQL or storage administration interfaces publicly
unless you understand and secure the resulting risk.

## 8. Changes and contact

This notice may be updated as the project changes. Material revisions should update the
effective date above.

For non-sensitive privacy questions about the Haejeok RisuAI software distribution, use
the GitHub repository's maintainer channels. Do not post personal data, credentials, private
prompts, or security-sensitive details in a public issue.

Operators who make a Haejeok RisuAI instance available to other people should publish a
privacy notice appropriate to their own deployment and jurisdiction. This document is a
project-level baseline and is not a substitute for legal advice.
