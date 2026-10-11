#!/usr/bin/env bash
set -euo pipefail
state=/var/lib/openttt/v2
config=/etc/openttt/v2
install -d -m 700 -o openttt -g openttt "$state"
install -d -m 750 -o root -g openttt "$config"
if [[ ! -f "$state/issuer.pem" ]]; then
  # systemd "active" precedes the existing server's asynchronous key creation.
  if systemctl is-active --quiet openttt-server.service; then
    for _ in $(seq 1 100); do [[ -f /var/lib/openttt/signing_key.hex ]] && break; sleep 0.1; done
    [[ -f /var/lib/openttt/signing_key.hex ]] || { echo 'Existing issuer has not initialized' >&2; exit 1; }
  fi
  # Reuse the production AMI issuer identity if present; otherwise mint per instance.
  node --input-type=module - "$state/issuer.pem" <<'JS'
import fs from 'node:fs';import crypto from 'node:crypto';
const seedFile='/var/lib/openttt/signing_key.hex';
let key;
if(fs.existsSync(seedFile)){
 const seed=fs.readFileSync(seedFile,'utf8').trim();
 if(!/^[0-9a-f]{64}$/i.test(seed))throw new Error('Invalid existing production signing key');
 key=crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(seed,'hex')]),format:'der',type:'pkcs8'});
}else key=crypto.generateKeyPairSync('ed25519').privateKey;
fs.writeFileSync(process.argv[2],key.export({format:'pem',type:'pkcs8'}),{mode:0o600,flag:'wx'});
JS
fi
if [[ ! -f "$state/seal-token" ]]; then openssl rand -hex 32 > "$state/seal-token"; fi
chmod 600 "$state/issuer.pem" "$state/seal-token"
chown openttt:openttt "$state/issuer.pem" "$state/seal-token"
if [[ ! -f "$config/tls.key" ]]; then
  openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 365 \
    -keyout "$config/tls.key" -out "$config/tls.crt" -subj '/CN=tttps.local' \
    -addext 'subjectAltName=DNS:tttps.local,DNS:localhost,IP:127.0.0.1' >/dev/null 2>&1
fi
chmod 640 "$config/tls.key" "$config/tls.crt"
chown root:openttt "$config/tls.key" "$config/tls.crt"
if [[ ! -f /etc/tttps-xdp.conf ]]; then
  iface=$(ip -j route show default | python3 -c 'import json,sys;r=json.load(sys.stdin);d={x["dev"] for x in r if "dev" in x};assert len(d)==1;print(next(iter(d)))')
  [[ "$iface" =~ ^[a-zA-Z0-9_.:-]+$ ]]
  printf 'TTTPS_XDP_IFACE=%s\nTTTPS_XDP_BASE=/opt/openttt/v2/infra/tttps-xdp\n' "$iface" > /etc/tttps-xdp.conf
fi
