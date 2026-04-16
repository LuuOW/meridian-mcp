---
name: vpn-access-control
description: VPN-gated deployment security — UFW + Docker DOCKER-USER chain coexistence, per-port and per-domain VPN gating, vpn-on/vpn-off alias pattern, split-tunnel with public IP routing, and multi-layer access control for VPS infrastructure
keywords: ["vpn", "access", "control", "ufw", "docker", "user", "ip", "vps", "vpn-gated", "deployment", "security", "docker-user", "chain", "coexistence", "per-port", "per-domain", "gating", "vpn-on/vpn-off", "alias", "pattern"]
orb_class: irregular_satellite
---

# vpn-access-control

Access control pattern for VPS deployments where internal services must be reachable only from a WireGuard tunnel while the public site stays open. Three layers must be coordinated: UFW (for PM2/host processes), DOCKER-USER iptables chain (for Docker-exposed ports), and nginx snippets (for domain-level restrictions).

## Why UFW Alone Is Not Enough

Docker bypasses UFW by writing directly to iptables `nat` PREROUTING rules. A port bound `0.0.0.0:6333` in a Docker compose file is reachable from the internet even if UFW has no rule for 6333. You must also lock the `DOCKER-USER` chain.

```
UFW rules     → protect host-process ports (PM2, systemd services)
DOCKER-USER   → protect Docker-exposed ports (all docker compose `ports:`)
nginx snippet → protect domains at the HTTP layer (optional, defence-in-depth)
```

## DOCKER-USER Lock

```bash
# Block all external non-VPN traffic reaching Docker containers
iptables -I DOCKER-USER -i eth0 '!' -s 10.0.0.0/24 -j DROP

# Verify
iptables -L DOCKER-USER -n --line-numbers
# Expected:
# 1  DROP  0  --  !10.0.0.0/24  0.0.0.0/0
# 2  ACCEPT 0  --  172.16.0.0/12  0.0.0.0/0   (Docker internal — must be present)
# 3  ACCEPT 0  --  0.0.0.0/0    0.0.0.0/0    ctstate RELATED,ESTABLISHED

# Remove the lock
iptables -D DOCKER-USER -i eth0 '!' -s 10.0.0.0/24 -j DROP
```

**Note:** The `-i eth0` flag scopes the rule to the external interface. Without it, you also block Docker-internal traffic. Use `ip link` to verify your interface name (`eth0`, `ens3`, `enp3s0` — it varies by VPS provider).

## UFW — VPN-Only Port Rules

```bash
# Enable UFW safely — allow SSH first or you lock yourself out
ufw allow 22/tcp     comment "SSH"
ufw allow 443        comment "WireGuard"
ufw allow 80/tcp     comment "HTTP"
ufw allow 8082/tcp   comment "nginx public site"
ufw --force enable

# Restrict a port to VPN subnet only
ufw allow from 10.0.0.0/24 to any port 4401 proto tcp comment "VPN-only :4401"

# Restore a port to public
ufw delete allow from 10.0.0.0/24 to any port 4401 proto tcp
ufw allow 4401/tcp

# Check result
ufw status verbose
```

**UFW PATH issue:** On some systems `ufw` lives at `/usr/sbin/ufw` and is not in the default `PATH`. If `ufw: command not found` but `apt show ufw` shows it's installed:

```bash
export PATH="$PATH:/usr/sbin"
# or use the full path
/usr/sbin/ufw status
```

## nginx Domain Snippets

```nginx
# /etc/nginx/snippets/vpn-access-internal.conf
# Write this file to restrict a vhost; comment it out to open it

allow 10.0.0.0/24;
deny all;
```

```nginx
# /etc/nginx/sites-enabled/app.conf
server {
    server_name internal-tool.example.com;
    include /etc/nginx/snippets/vpn-access-internal.conf;
    # ... rest of config
}
```

```bash
# Validate and reload after writing the snippet
nginx -t && systemctl reload nginx
```

## vpn-on / vpn-off Alias Pattern

Store in `/root/.bash_aliases` (sourced by `.bashrc`). Three coordinated functions per command: UFW per-port rules + nginx snippets + DOCKER-USER chain.

```bash
# /root/.bash_aliases

_vpn_set_port_mode() {
  local mode="$1" port="$2"
  ufw delete allow "${port}/tcp"                          > /dev/null 2>&1 || true
  ufw delete allow from 10.0.0.0/24 to any port "$port" proto tcp > /dev/null 2>&1 || true
  if [[ "$mode" == "add" ]]; then
    ufw allow from 10.0.0.0/24 to any port "$port" proto tcp comment "VPN-only :$port" > /dev/null
  else
    ufw allow "${port}/tcp" > /dev/null
  fi
}

_vpn_set_domain_mode() {
  local mode="$1" domain="$2"
  local snippet="/etc/nginx/snippets/vpn-access-${domain//./-}.conf"
  if [[ "$mode" == "add" ]]; then
    printf "allow 10.0.0.0/24;\ndeny all;\n" > "$snippet"
  else
    printf "# public access enabled\n" > "$snippet"
  fi
  nginx -t > /dev/null && systemctl reload nginx
}

_vpn_docker_lock()   { iptables -D DOCKER-USER -i eth0 '!' -s 10.0.0.0/24 -j DROP 2>/dev/null; iptables -I DOCKER-USER -i eth0 '!' -s 10.0.0.0/24 -j DROP; }
_vpn_docker_unlock() { iptables -D DOCKER-USER -i eth0 '!' -s 10.0.0.0/24 -j DROP 2>/dev/null; }

vpn-on() {
  for port in 3000 3001 3002 4401 4402 5678 6333 6379 8000 9002; do
    _vpn_set_port_mode add "$port"
  done
  _vpn_set_domain_mode add "internal.example.com"
  _vpn_docker_lock
  echo "VPN-only mode active"
}

vpn-off() {
  for port in 3000 3001 3002 4401 4402 5678 6333 6379 8000 9002; do
    _vpn_set_port_mode remove "$port"
  done
  _vpn_set_domain_mode remove "internal.example.com"
  _vpn_docker_unlock
  echo "Public mode active"
}

# Granular control
vpn-add()    { _vpn_scope add    "$@"; }   # vpn-add -p 8000  /  vpn-add -d app.com
vpn-remove() { _vpn_scope remove "$@"; }   # vpn-remove -p 8000

_vpn_scope() {
  local mode="$1" flag="$2" value="$3"
  case "$flag" in
    -p) _vpn_set_port_mode   "$mode" "$value" ;;
    -d) _vpn_set_domain_mode "$mode" "$value" ;;
    *)  echo "Usage: vpn-add -p <port> | vpn-add -d <domain>" >&2; return 1 ;;
  esac
}
```

## Client Config — Split Tunnel + Public VPS IP

To use `45.9.190.170:4401` (public VPS IP) from the Mac while tunnelled, add the VPS IP to `AllowedIPs`. Traffic to the public IP goes through the tunnel, arrives at the server as `10.0.0.x`, and passes UFW.

```ini
[Interface]
PrivateKey = <client-private-key>
Address    = 10.0.0.3/24
DNS        = 1.1.1.1

[Peer]
PublicKey           = <server-public-key>
PresharedKey        = <psk>
Endpoint            = 45.9.190.170:443
AllowedIPs          = 10.0.0.0/24, 45.9.190.170/32   # ← VPS IP through tunnel
PersistentKeepalive = 25
```

Without `45.9.190.170/32` in `AllowedIPs`, traffic to the public IP bypasses the tunnel and UFW blocks it.

## Adding a New Peer

```bash
# Generate PSK
wg genpsk

# Add to /etc/wireguard/wg0.conf
[Peer]
# name here
PublicKey    = <new-client-pubkey>
PresharedKey = <new-psk>
AllowedIPs   = 10.0.0.4/32      # next available slot

# Add to running interface (no restart needed)
wg set wg0 peer <new-client-pubkey> \
  preshared-key <(echo "<new-psk>") \
  allowed-ips 10.0.0.4/32

# Verify
wg show wg0
```

## Verification

```bash
# Confirm VPN peer connected
wg show wg0                          # should show recent handshake

# Confirm Docker ports are blocked externally
# From a machine NOT on the VPN:
curl -m 3 http://45.9.190.170:6333  # should time out / connection refused

# From a machine on the VPN:
curl -m 3 http://10.0.0.1:6333      # should respond

# Check active iptables state
iptables -L DOCKER-USER -n
ufw status verbose
```

## Checklist

- [ ] `DOCKER-USER` drop rule set — `iptables -L DOCKER-USER` shows non-VPN DROP at position 1
- [ ] UFW enabled with SSH/443/80 allowed before enable — never locked out
- [ ] UFW path verified: `which ufw` or `/usr/sbin/ufw`
- [ ] `vpn-on` / `vpn-off` in `/root/.bash_aliases`, sourced by `.bashrc`
- [ ] Client `AllowedIPs` includes `VPS_IP/32` if using public IP in browser
- [ ] `wg show` confirms handshake within last few minutes after client connects
- [ ] External `nmap` or `curl` confirms Docker ports (6333, 6379, 27017) are unreachable
- [ ] `nginx -t && systemctl reload nginx` runs after every snippet change
- [ ] Peer table in project-docs updated with each new client added
