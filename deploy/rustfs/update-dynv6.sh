#!/bin/sh
set -eu

token_file=${DYNV6_TOKEN_FILE:-/run/secrets/dynv6_token}
update_interval=${DYNV6_UPDATE_INTERVAL:-300}
connect_timeout=${DYNV6_CONNECT_TIMEOUT:-10}
request_timeout=${DYNV6_REQUEST_TIMEOUT:-30}
ipv6_enabled=${DYNV6_IPV6:-false}
run_once=${DYNV6_ONCE:-false}

if [ -z "${DYNV6_ZONE:-}" ]; then
    echo "DYNV6_ZONE is required" >&2
    exit 1
fi

if [ "${#DYNV6_ZONE}" -gt 253 ] || ! printf '%s\n' "$DYNV6_ZONE" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$'; then
    echo "DYNV6_ZONE must be a valid fully qualified hostname" >&2
    exit 1
fi

if [ ! -s "$token_file" ]; then
    echo "The dynv6 token secret is missing or empty" >&2
    exit 1
fi

validate_range() {
    range_name=$1
    range_value=$2
    range_min=$3
    range_max=$4
    case "$range_value" in ''|*[!0-9]*) echo "$range_name must be an integer" >&2; exit 1 ;; esac
    awk -v value="$range_value" -v minimum="$range_min" -v maximum="$range_max" 'BEGIN { exit !(value >= minimum && value <= maximum) }' || {
        echo "$range_name must be from $range_min to $range_max" >&2
        exit 1
    }
}

validate_range DYNV6_UPDATE_INTERVAL "$update_interval" 60 86400
validate_range DYNV6_CONNECT_TIMEOUT "$connect_timeout" 1 300
validate_range DYNV6_REQUEST_TIMEOUT "$request_timeout" 1 600
case "$ipv6_enabled" in true|false) ;; *) echo "DYNV6_IPV6 must be true or false" >&2; exit 1 ;; esac
case "$run_once" in true|false) ;; *) echo "DYNV6_ONCE must be true or false" >&2; exit 1 ;; esac

update_address() {
    token=$(cat "$token_file")
    if [ -z "$token" ]; then
        echo "The dynv6 token secret is empty" >&2
        return 1
    fi

    if ! ipv4_result=$(curl --fail --silent --show-error --get \
        --connect-timeout "$connect_timeout" \
        --max-time "$request_timeout" \
        --retry 2 \
        --retry-delay 1 \
        --retry-all-errors \
        --data-urlencode "zone=$DYNV6_ZONE" \
        --data-urlencode "token=$token" \
        --data-urlencode "ipv4=auto" \
        https://ipv4.dynv6.com/api/update); then
        echo "dynv6 IPv4 update failed" >&2
        return 1
    fi
    printf '%s\n' "$ipv4_result"

    if [ "$ipv6_enabled" = true ]; then
        if ! ipv6_result=$(curl --fail --silent --show-error --get \
            --connect-timeout "$connect_timeout" \
            --max-time "$request_timeout" \
            --retry 2 \
            --retry-delay 1 \
            --retry-all-errors \
            --data-urlencode "zone=$DYNV6_ZONE" \
            --data-urlencode "token=$token" \
            --data-urlencode "ipv6=auto" \
            https://ipv6.dynv6.com/api/update); then
            echo "dynv6 IPv6 update failed after the IPv4 update; the next cycle will retry both families" >&2
            return 1
        fi
        printf '%s\n' "$ipv6_result"
    fi
}

if [ "$run_once" = true ]; then
    update_address
    exit 0
fi

sleep_pid=
terminate() {
    [ -z "$sleep_pid" ] || kill "$sleep_pid" 2>/dev/null || true
    exit 0
}
trap terminate 1 2 15

while :; do
    if ! update_address; then
        echo "dynv6 update failed; retrying at the next interval" >&2
    fi
    sleep "$update_interval" &
    sleep_pid=$!
    wait "$sleep_pid" || true
    sleep_pid=
done
