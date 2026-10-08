#!/bin/sh
# Generates the "api" upstream from API_UPSTREAMS (space-separated host:port).
#
#   Docker Compose: API_UPSTREAMS="api-1:3000 api-2:3000"
#   Railway:        API_UPSTREAMS="api.railway.internal:3000" (replicas share the name)
#
# Names are re-resolved every 5 s with the container's own DNS server (from
# /etc/resolv.conf, exported by the image's 15-local-resolvers step), so a
# redeployed or scaled API never leaves nginx pointing at old addresses.
set -eu

if [ -z "${API_UPSTREAMS:-}" ]; then
  echo "25-bidrush-upstream: set API_UPSTREAMS (e.g. api.railway.internal:3000)" >&2
  exit 1
fi

out=/etc/nginx/conf.d/00-upstream.conf
{
  echo "upstream api {"
  echo "    zone api 64k;"
  echo "    resolver ${NGINX_LOCAL_RESOLVERS} valid=5s;"
  for server in $API_UPSTREAMS; do
    echo "    server ${server} resolve;"
  done
  echo "}"
} > "$out"

echo "25-bidrush-upstream: api -> $API_UPSTREAMS (resolver ${NGINX_LOCAL_RESOLVERS})"
