#!/usr/bin/env bash
# Deploy webos-tvos-launcher directly to LG TV via Root SSH (Port 22)

set -e

TV_IP="192.168.1.6"
SSH_KEY="$HOME/.ssh/webos_rsa"
REMOTE_PATH="/media/developer/apps/usr/palm/applications/com.apple.aerial.tvos"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== 1. Deploying index.html and appinfo.json to TV ($TV_IP:22) ==="
scp -i "$SSH_KEY" -P 22 -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa \
  "$LOCAL_DIR/src/index.html" "root@$TV_IP:$REMOTE_PATH/index.html"

scp -i "$SSH_KEY" -P 22 -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa \
  "$LOCAL_DIR/appinfo.json" "root@$TV_IP:$REMOTE_PATH/appinfo.json"

echo "=== 1b. Deploying fonts ==="
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa "root@$TV_IP" "mkdir -p $REMOTE_PATH/fonts"
scp -i "$SSH_KEY" -P 22 -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa \
  "$LOCAL_DIR/src/fonts/"*.woff2 "root@$TV_IP:$REMOTE_PATH/fonts/"

echo "=== 1c. Deploying Boot and Daemon scripts ==="
scp -i "$SSH_KEY" -P 22 -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa \
  "$LOCAL_DIR/config/bootd.json" "root@$TV_IP:/var/luna/preferences/bootd.json"

scp -i "$SSH_KEY" -P 22 -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa \
  "$LOCAL_DIR/scripts/10-debloat" \
  "$LOCAL_DIR/scripts/20-aerial-launcher" \
  "$LOCAL_DIR/scripts/21-aerial-daemon" \
  "$LOCAL_DIR/scripts/aerial-daemon.js" \
  "root@$TV_IP:/var/lib/webosbrew/"

ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa "root@$TV_IP" \
  "cp /var/lib/webosbrew/10-debloat /var/lib/webosbrew/init.d/10-debloat && cp /var/lib/webosbrew/20-aerial-launcher /var/lib/webosbrew/init.d/20-aerial-launcher && cp /var/lib/webosbrew/21-aerial-daemon /var/lib/webosbrew/init.d/21-aerial-daemon && chmod +x /var/lib/webosbrew/init.d/*"

echo "=== 2. Reloading TV page via Chrome Remote Debugging (port 9998) ==="
python3 "$LOCAL_DIR/scripts/reload_cdp.py"

echo "=== Deploy & Reload Completed Successfully! ==="
