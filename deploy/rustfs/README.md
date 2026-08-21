# RisuAI PostgreSQL + RustFS deployment

`risuai.sh` installs the shared RisuAI, PostgreSQL, and RustFS stack, then adds
only the networking services required by the selected mode. Run
`./risuai.sh install` for the interactive menu; it defaults to `local`.

| Mode | Access | Extra services |
| --- | --- | --- |
| `local` | `http://localhost:6001` | None |
| `lan` | `http://SERVER-IP:6001` | Publishes RisuAI on all interfaces |
| `domain` | `https://your-domain` | Caddy, optionally Cloudflare DDNS |
| `dynv6` | `https://name.dynv6.net` | Caddy and dynv6 DDNS |
| `proxy` | Existing reverse proxy | Host loopback port or external Docker network |

PostgreSQL is never published. RustFS ports 9000 and 9001 remain bound to
localhost in every mode. Its console can be reached remotely through an SSH
tunnel if required.

## Non-interactive examples

```sh
./risuai.sh install --mode local -y
./risuai.sh install --mode lan -y

# Domain with an A/AAAA record managed outside this installer
./risuai.sh install --mode domain --domain chat.example.com \
  --dns-provider manual -y

# Domain with Cloudflare DDNS
./risuai.sh install --mode domain --domain chat.example.com \
  --dns-provider cloudflare \
  --cloudflare-zone-id 0123456789abcdef0123456789abcdef \
  --cloudflare-token "$CLOUDFLARE_TOKEN" --ipv6 -y

# dynv6 DDNS (--token remains a compatibility alias)
./risuai.sh install --mode dynv6 --domain my-chat.dynv6.net \
  --dynv6-token "$DYNV6_TOKEN" --ipv6 -y

# Reverse proxy installed directly on the host
./risuai.sh install --mode proxy --proxy-type host -y

# Reverse proxy running in Docker
docker network create reverse-proxy
./risuai.sh install --mode proxy --proxy-type docker \
  --proxy-network reverse-proxy -y
```

Secrets can also be supplied as `DYNV6_TOKEN` or `CLOUDFLARE_TOKEN`
environment variables. The installer stores provider tokens separately in
mode-specific files with permission `0600`; it never writes them to
`rustfs.env`. Reinstalling preserves the PostgreSQL and RustFS credentials and
named volumes. It validates the prospective configuration first, uses
`--remove-orphans` to remove services from the previous mode, and then deletes
the no-longer-used provider token.

## DNS, TLS, and firewalls

For `domain` with manual DNS, create an A record (and an AAAA record only when
IPv6 is usable) pointing the hostname at this server. Cloudflare mode uses a
32-character Zone ID and an API token limited to that zone with DNS Write
permission. New records are DNS-only with automatic TTL; updates change only
the address, preserving existing TTL and proxy settings. An existing AAAA is
not deleted when `--ipv6` is omitted. The updater uses Cloudflare's DNS record
[lookup](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/),
[create](https://developers.cloudflare.com/api/typescript/resources/dns/subresources/records/methods/create),
and [edit](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/edit/)
APIs and stops safely on duplicate records or a CNAME conflict.

The `domain` and `dynv6` modes require public TCP ports 80 and 443 to reach the
server; UDP 443 enables HTTP/3. Forward TCP 80/443 through the router/NAT and
allow them in any cloud firewall. The installer adds TCP 80/443 rules when UFW
is active. DNS must resolve publicly before Caddy can complete
[automatic HTTPS](https://caddyserver.com/docs/automatic-https).

`lan` deliberately exposes unencrypted HTTP on TCP 6001 and does not alter the
firewall. Use it only on a trusted network and never forward port 6001 to the
internet.

## Existing reverse proxies

With `--proxy-type host`, configure the proxy upstream as
`http://127.0.0.1:6001`. With `--proxy-type docker`, the named network must
already exist. Only RisuAI joins it; PostgreSQL and RustFS remain solely on the
private default network. Configure the proxy upstream as
`http://risuai:6001`. Compose treats that network as an
[existing external network](https://docs.docker.com/compose/how-tos/networking/#use-an-existing-network),
and the installer will not create or modify it.

## Management

```sh
./risuai.sh start
./risuai.sh stop
./risuai.sh restart
./risuai.sh rebuild
./risuai.sh status
./risuai.sh logs [service]
```

All commands load the saved mode and the same Compose overlays. `stop` does not
delete data, and `rebuild` recreates only the RisuAI application.
