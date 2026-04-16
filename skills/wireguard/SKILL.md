---
name: wireguard
description: WireGuard VPN setup and management — server/client config, key management, peer routing, split-tunnel vs full-tunnel, multi-peer topologies, and systemd integration for production admin access
---

# wireguard

Production WireGuard VPN for securing admin access to VPS infrastructure. Covers server setup, client configuration, key lifecycle, routing topologies, and systemd persistence.

## Key Generation

```bash
# Install
apt install wireguard

# Generate a key pair (do this for every peer — server and each client)
wg genkey | tee /etc/wireguard/private.key | wg pubkey > /etc/wireguard/public.key
chmod 600 /etc/wireguard/private.key

# Pre-shared key (optional, adds post-quantum resistance)
wg genpsk > /etc/wireguard/psk.key
chmod 600 /etc/wireguard/psk.key

# View keys
cat /etc/wireguard/public.key
```

**Key hygiene:**
- Private keys never leave the machine they were generated on
- Pre-shared key must be the same on both peers — share via encrypted channel (not chat)
- Rotate keys by regenerating the pair and re-distributing the new public key to all peers

## Server Configuration

```ini
# /etc/wireguard/wg0.conf — server (hub in a hub-and-spoke topology)
[Interface]
Address    = 10.8.0.1/24
ListenPort = 51820
PrivateKey = <server-private-key>

# Enable NAT so VPN clients can reach the internet through the server
PostUp   = iptables -A FORWARD -i wg0 -j ACCEPT; \
           iptables -A FORWARD -o wg0 -j ACCEPT; \
           iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; \
           iptables -D FORWARD -o wg0 -j ACCEPT; \
           iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

# ── Peer: developer laptop ──
[Peer]
PublicKey    = <client-public-key>
PresharedKey = <psk>                  # optional
AllowedIPs   = 10.8.0.2/32            # this peer's VPN IP only

# ── Peer: CI server ──
[Peer]
PublicKey  = <ci-public-key>
AllowedIPs = 10.8.0.3/32
```

```bash
# Requires IP forwarding — verify it's on
sysctl net.ipv4.ip_forward   # should be 1
# Make permanent:
echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.d/99-wireguard.conf
sysctl -p /etc/sysctl.d/99-wireguard.conf
```

## Client Configuration

```ini
# /etc/wireguard/wg0.conf — client (split-tunnel: only internal ranges via VPN)
[Interface]
Address    = 10.8.0.2/24
PrivateKey = <client-private-key>
DNS        = 10.8.0.1            # use server as DNS resolver (optional)

[Peer]
PublicKey           = <server-public-key>
PresharedKey        = <psk>
Endpoint            = server-ip:51820
AllowedIPs          = 10.8.0.0/24, 10.0.0.0/8    # split-tunnel: only VPN + internal ranges
PersistentKeepalive = 25                           # keep NAT open (set if behind NAT)
```

```ini
# Full-tunnel client (all traffic through VPN)
[Peer]
AllowedIPs = 0.0.0.0/0, ::/0     # route everything through VPN
```

**Split-tunnel vs full-tunnel:**

| Mode | `AllowedIPs` | Use when |
|------|-------------|----------|
| Split-tunnel | `10.8.0.0/24, 10.0.0.0/8` | Only need access to internal services; local internet unchanged |
| Full-tunnel | `0.0.0.0/0` | Need all traffic routed through VPN (untrusted networks) |

## Start, Stop, and Persistence

```bash
# Manual start/stop
wg-quick up wg0
wg-quick down wg0

# Enable at boot via systemd
systemctl enable --now wg-quick@wg0
systemctl status wg-quick@wg0

# Check state
wg show                 # all peers, handshake times, bytes transferred
wg show wg0             # specific interface
wg showconf wg0         # full running config (including resolved keys)
```

## Multi-Peer Topology

```ini
# /etc/wireguard/wg0.conf — mesh node (each server knows all others)
[Interface]
Address    = 10.8.0.10/24
ListenPort = 51820
PrivateKey = <this-node-private-key>

# Node A
[Peer]
PublicKey  = <node-a-public>
AllowedIPs = 10.8.0.1/32
Endpoint   = node-a-ip:51820

# Node B
[Peer]
PublicKey  = <node-b-public>
AllowedIPs = 10.8.0.2/32
Endpoint   = node-b-ip:51820
```

```bash
# Add a peer at runtime (no restart needed)
wg set wg0 peer <new-public-key> allowed-ips 10.8.0.5/32 endpoint new-host:51820

# Remove a peer at runtime
wg set wg0 peer <public-key> remove

# Save runtime changes back to config
wg-quick save wg0
```

## Firewall Rules for WireGuard

```bash
# UFW — allow WireGuard port
ufw allow 51820/udp

# Allow VPN subnet to reach internal services
ufw allow from 10.8.0.0/24 to any port 22
ufw allow from 10.8.0.0/24 to any port 5432    # Postgres via VPN only
ufw allow from 10.8.0.0/24 to any port 6379    # Redis via VPN only
```

## Diagnostics

```bash
# Last handshake time — nonzero means tunnel is alive
wg show wg0 latest-handshakes

# Check packet counters per peer
wg show wg0 transfer

# Verify routing
ip route show table main | grep 10.8.0

# Ping a peer across VPN
ping 10.8.0.2

# Check if traffic is flowing through the tunnel
tcpdump -i wg0 -n icmp
```

## Split-Tunnel + Public VPS IP

Default split-tunnel (`AllowedIPs = 10.8.0.0/24`) routes only VPN-subnet traffic through the tunnel. If you also want to reach the server by its **public IP** (e.g. `45.9.190.170:4401`) from a tunnelled client, add the public IP to `AllowedIPs`:

```ini
[Peer]
AllowedIPs = 10.8.0.0/24, 45.9.190.170/32
```

Traffic to `45.9.190.170` now flows through the tunnel, arrives at the server sourced from `10.8.0.x`, and passes firewall rules that allow the VPN subnet. Without this, the client hits the public IP over the open internet and UFW/DOCKER-USER blocks it.

## Common Mistakes

- Not enabling `net.ipv4.ip_forward` — without it, peers can reach the server but not talk to each other or reach the internet through the VPN
- Setting `AllowedIPs = 0.0.0.0/0` on a split-tunnel client — routes all traffic through the VPN unexpectedly
- Firewall missing `FORWARD` rules — packets arrive but can't transit to internal network
- Same `Address` on two peers — causes routing conflicts; each peer must have a unique `/32` within the VPN subnet
- Running `wg-quick up` and then editing the config without `wg-quick down` + `up` — runtime state and config drift
- Using the server's public IP in the browser without adding it to `AllowedIPs` — traffic bypasses the tunnel, UFW blocks the port
