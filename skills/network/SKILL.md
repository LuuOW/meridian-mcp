---
name: network
description: Framework-agnostic production networking authority — TCP/IP stack, interface and routing management, firewall policy, traffic inspection, VPN, bandwidth diagnostics, and cross-layer reachability debugging for bare-metal and cloud VPS environments
---

# network

General-purpose production networking for self-hosted VPS and cloud VM deployments. Framework-agnostic — applies across Python, Node, Go, and any service running on Linux. Covers the full stack from kernel interface configuration through application-layer diagnostics. Anchors specialist skills in DNS, TLS, VPN, firewall, and port scanning.

## Interface and Address Management

```bash
# Show all interfaces and addresses
ip addr show
ip link show

# Bring interface up/down
ip link set eth0 up
ip link set eth0 down

# Add a temporary IP alias (survives until reboot)
ip addr add 10.0.0.2/24 dev eth0

# Show routing table and trace path to a host
ip route show
ip route get 8.8.8.8

# Show ARP cache
ip neigh show
```

```yaml
# /etc/netplan/00-installer-config.yaml — Ubuntu 22.04+
network:
  version: 2
  ethernets:
    eth0:
      dhcp4: true
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
      routes:
        - to: 10.0.0.0/8
          via: 192.168.1.1
```

```bash
netplan apply     # apply without reboot
netplan try       # apply with 2-min auto-rollback
```

## Port and Socket Inspection

```bash
# What is listening and who owns it
ss -tlnp          # TCP listening, numeric, with process
ss -ulnp          # UDP listening
ss -tnp state established        # active connections
ss -tlnp sport = :443            # filter to port 443
ss -s                            # socket summary (counts by state)

# Which process owns a port
lsof -i :8080
fuser 8080/tcp

# Watch connection counts in real time
watch -n1 'ss -s'
```

## Routing and Forwarding

```bash
# Enable kernel IP forwarding (required for VPN gateways and Docker)
echo 'net.ipv4.ip_forward=1'          >> /etc/sysctl.conf
echo 'net.ipv6.conf.all.forwarding=1' >> /etc/sysctl.conf
sysctl -p

# Port forwarding: redirect external :80 to internal :8080
iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 8080

# MASQUERADE (NAT for VPN/container egress)
iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE

# Policy routing: send traffic from 10.8.0.0/24 via a different gateway
ip rule add from 10.8.0.0/24 table 100
ip route add default via 192.168.2.1 table 100
```

## Firewall — UFW

```bash
# Initial hardened setup
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# Allow from a specific IP range only
ufw allow from 203.0.113.0/24 to any port 5432

# Rate-limit SSH (blocks IPs after 6 attempts / 30s)
ufw limit OpenSSH

# Named app profiles
ufw app list
ufw allow 'Nginx Full'

# Inspect and modify
ufw status verbose
ufw status numbered
ufw delete 3        # remove rule by number
ufw reload
```

## Firewall — iptables / nftables

```bash
# Save and restore (survives reboot with iptables-persistent)
iptables-save  > /etc/iptables/rules.v4
ip6tables-save > /etc/iptables/rules.v6
iptables-restore < /etc/iptables/rules.v4

# Drop all traffic from an IP
iptables -A INPUT -s 203.0.113.42 -j DROP

# Allow established connections only (stateful)
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Log and drop unknown inbound traffic
iptables -A INPUT -j LOG --log-prefix "DROPPED: " --log-level 4
iptables -A INPUT -j DROP
```

```nft
# nftables — modern replacement for iptables
nft list ruleset

table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    iif lo accept
    ct state established,related accept
    tcp dport { 22, 80, 443 } accept
    drop
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
  }
  chain output {
    type filter hook output priority 0; policy accept;
  }
}
```

## Traffic Inspection

```bash
# tcpdump — packet capture
tcpdump -i eth0 port 80 -n
tcpdump -i any host 10.0.0.5 -n
tcpdump -i eth0 'tcp[tcpflags] & tcp-syn != 0'         # SYN flood detection
tcpdump -w /tmp/capture.pcap -i eth0 port 443           # capture to file

# Live bandwidth per connection / per process
iftop -i eth0 -n        # per-connection bandwidth
nethogs eth0            # per-process bandwidth
nload eth0              # total interface throughput

# Connection state summary
ss -s
```

## Reachability Diagnostics

```bash
# Layer 3 reachability
ping -c 4 google.com
traceroute google.com
traceroute -T -p 443 google.com      # TCP SYN trace (bypasses ICMP filters)
mtr --report google.com              # combined traceroute + stats

# Layer 4 / application
nc -zv host.example.com 443          # TCP connect test
nc -zvu host.example.com 53          # UDP test
curl -sv --max-time 5 https://api.example.com/health
curl -I https://example.com          # headers only

# DNS
dig +short example.com
dig @1.1.1.1 example.com             # query specific resolver
dig +trace example.com               # full delegation chain
```

## Bandwidth and Latency Measurement

```bash
# Measure throughput between two hosts
# On receiver:
iperf3 -s
# On sender:
iperf3 -c server-ip -t 10 -P 4      # 10s, 4 parallel streams

# Latency distribution
hping3 -c 100 -S -p 443 target-ip

# NIC speed
ethtool eth0 | grep Speed

# Quick public bandwidth check
curl -o /dev/null https://speed.cloudflare.com/__down?bytes=50000000 2>&1 \
  | grep -E "speed|time"
```

## Kernel Network Security Hardening

```bash
# /etc/sysctl.d/99-network-hardening.conf
# SYN flood mitigation
net.ipv4.tcp_syncookies = 1

# Disable ICMP redirects (prevent MITM routing attacks)
net.ipv4.conf.all.send_redirects    = 0
net.ipv4.conf.all.accept_redirects  = 0
net.ipv6.conf.all.accept_redirects  = 0

# Disable source routing
net.ipv4.conf.all.accept_source_route = 0

# Log martian packets (packets with impossible source addresses)
net.ipv4.conf.all.log_martians = 1

# Ignore ICMP broadcast (Smurf amplification)
net.ipv4.icmp_echo_ignore_broadcasts = 1

# Connection tracking table size (scale with expected concurrent connections)
net.netfilter.nf_conntrack_max = 131072
```

```bash
sysctl -p /etc/sysctl.d/99-network-hardening.conf
```

## Network Topology Reference

```
Internet
    │
   UFW / nftables (edge firewall)
    │
   Nginx (443/80 — only ports open)
    │
   ┌──────────────────────────┐
   │   Internal bridge net    │
   │  api:9002  worker:----   │
   │  db:5432   redis:6379    │
   └──────────────────────────┘
    │
   WireGuard wg0 (10.8.0.0/24 — admin VPN)

Rule: Only 80/443 open to world.
      Internal ports bound to 127.0.0.1 only.
      Admin access via VPN only.
```

## Diagnostics Cheatsheet

| Goal | Command |
|------|---------|
| What's listening | `ss -tlnp` |
| Who owns port X | `lsof -i :X` |
| Layer 3 reachability | `ping -c 4 <host>` |
| TCP path trace | `traceroute -T -p 443 <host>` |
| Continuous path stats | `mtr --report <host>` |
| DNS resolution | `dig +short <domain>` |
| Full DNS trace | `dig +trace <domain>` |
| HTTP check | `curl -sv https://<host>/health` |
| TCP connect test | `nc -zv <host> <port>` |
| Capture packets | `tcpdump -i eth0 port 80 -n` |
| Live bandwidth | `iftop -i eth0 -n` |
| Per-process BW | `nethogs eth0` |
| Test throughput | `iperf3 -c <server>` |
| Firewall rules | `ufw status verbose` |
| Routing table | `ip route show` |

## Production Checklist

- [ ] Only 22/80/443 open in firewall — all internal ports bound to `127.0.0.1`
- [ ] `ufw limit OpenSSH` — brute-force protection
- [ ] IP forwarding enabled if running VPN or Docker bridges
- [ ] SYN cookies on: `net.ipv4.tcp_syncookies=1`
- [ ] ICMP redirects disabled: `accept_redirects=0`, `send_redirects=0`
- [ ] `iptables-save` persisted with `iptables-persistent`
- [ ] No plain-text services (Redis, Postgres) exposed on public interfaces
- [ ] `mtr` baseline captured after provisioning new servers
- [ ] WireGuard peer `AllowedIPs` scoped to minimum required subnets
- [ ] Martian packet logging enabled for anomaly detection
