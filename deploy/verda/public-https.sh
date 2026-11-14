#!/bin/sh
# Gives Nemotron on the Verda instance a public HTTPS address, so a hosted server (which cannot use the SSH
# tunnel) can reach it. The model server itself is not touched or restarted: a small Caddy container on the
# instance listens on ports 80 and 443, gets a certificate by itself, and passes requests to 127.0.0.1:8000.
# Every request still needs the model server's own API key (VERDA_API_KEY); without it the answer is 401.
#
#   sh deploy/verda/public-https.sh <instance-ip> [path-to-ssh-key]     switch it on (safe to run again)
#   sh deploy/verda/public-https.sh <instance-ip> [path-to-ssh-key] off switch it off again
#
# The address is https://<ip-with-dashes>.nip.io/v1, for example https://203-0-113-7.nip.io/v1.
# Use it as VERDA_BASE_URL on the hosted server. The laptop can keep using the tunnel.
set -eu
IP="${1:?Give the Verda instance IP address}"
KEY="${2:-$HOME/.ssh/sisu_verda}"
MODE="${3:-on}"
if [ "$KEY" = "off" ]; then KEY="$HOME/.ssh/sisu_verda"; MODE="off"; fi
HOST="$(echo "$IP" | tr . -).nip.io"
SSH="ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new root@$IP"

if [ "$MODE" = "off" ]; then
  $SSH 'docker rm -f sisu-https >/dev/null 2>&1 || true'
  echo "Switched off: the model is reachable only through the SSH tunnel again."
  exit 0
fi

$SSH "docker rm -f sisu-https >/dev/null 2>&1 || true
docker run -d --name sisu-https --restart unless-stopped --network host \
  -v sisu_caddy_data:/data -v sisu_caddy_config:/config \
  caddy:2 caddy reverse-proxy --from $HOST --to 127.0.0.1:8000 >/dev/null"

echo "Waiting for the certificate..."
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$HOST/v1/models" || true)
  if [ "$CODE" = "401" ] || [ "$CODE" = "200" ]; then
    echo "Ready: https://$HOST/v1 (answers $CODE without a key, as it should)."
    echo "Set VERDA_BASE_URL=https://$HOST/v1 on the hosted server."
    exit 0
  fi
  sleep 5
done
echo "No answer yet from https://$HOST/v1 (last status: ${CODE:-none}). Look at: $SSH docker logs --tail 30 sisu-https" >&2
exit 1
