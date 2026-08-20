#!/bin/sh
set -eu

token_file=/run/secrets/dynv6_token

if [ -z "${DYNV6_ZONE:-}" ]; then
    echo "DYNV6_ZONE is required" >&2
    exit 1
fi

if [ ! -s "$token_file" ]; then
    echo "The dynv6 token secret is missing or empty" >&2
    exit 1
fi

case "${DYNV6_UPDATE_INTERVAL:-300}" in
    *[!0-9]*|'')
        echo "DYNV6_UPDATE_INTERVAL must be an integer" >&2
        exit 1
        ;;
esac

if [ "${DYNV6_UPDATE_INTERVAL:-300}" -lt 60 ]; then
    echo "DYNV6_UPDATE_INTERVAL must be at least 60 seconds" >&2
    exit 1
fi

update_address() {
    token=$(cat "$token_file")

    curl --fail --silent --show-error --get \
        --data-urlencode "zone=$DYNV6_ZONE" \
        --data-urlencode "token=$token" \
        --data-urlencode "ipv4=auto" \
        https://ipv4.dynv6.com/api/update
    echo

    if [ "${DYNV6_IPV6:-false}" = "true" ]; then
        curl --fail --silent --show-error --get \
            --data-urlencode "zone=$DYNV6_ZONE" \
            --data-urlencode "token=$token" \
            --data-urlencode "ipv6=auto" \
            https://ipv6.dynv6.com/api/update
        echo
    fi
}

if [ "${DYNV6_ONCE:-false}" = "true" ]; then
    update_address
    exit 0
fi

while :; do
    if ! update_address; then
        echo "dynv6 update failed; retrying at the next interval" >&2
    fi
    sleep "${DYNV6_UPDATE_INTERVAL:-300}" &
    wait $!
done
