---
name: firewall
description: Production firewall management — UFW policy design, iptables/nftables rule authoring, stateful connection tracking, ingress/egress filtering, fail2ban integration, and firewall audit workflows for Linux servers
---

# firewall

Firewall configuration and policy management for Linux production servers. Covers UFW for most deployments, iptables and nftables for advanced routing scenarios, and fail2ban for adaptive IP banning. Orbits the network planet.

## UFW — Default Policy Design

Start from deny-all inbound, allow-all outbound. Add only what is explicitly required.

```bash
# Initial setup — run in order
ufw default deny incoming
ufw default allow outgoing

# Essential services
ufw allow OpenSSH              # 22/tcp — must do this BEFORE ufw enable
ufw allow 80/tcp               # HTTP
ufw allow 443/tcp              # HTTPS

# Activate
ufw enable
ufw status verbose
```

```bash
# Source-restricted rules (principle of least privilege)
ufw allow from 203.0.113.0/24 to any port 5432   # Postgres: specific subnet only
ufw allow from 10.8.0.0/24   to any port 22      # SSH: VPN subnet only
ufw deny  from 198.51.100.0/24                   # block entire range

# Rate-limit brute force on SSH (6 attempts / 30s → block)
ufw limit OpenSSH

# Named application profiles
ufw app list
ufw allow 'Nginx Full'         # opens both 80 and 443

# Modify and delete
ufw status numbered
ufw delete 5                   # remove by number
ufw insert 1 allow from 1.2.3.4   # insert at position 1 (highest priority)
ufw reload
```

## iptables — Hardened Base Ruleset

```bash
#!/bin/bash
# /opt/scripts/apply-iptables.sh — idempotent base ruleset

IPT="iptables"

# Flush everything
$IPT -F
$IPT -X
$IPT -t nat -F
$IPT -t mangle -F

# Default policies — drop everything, build up from nothing
$IPT -P INPUT   DROP
$IPT -P FORWARD DROP
$IPT -P OUTPUT  ACCEPT

# Allow loopback
$IPT -A INPUT -i lo -j ACCEPT

# Allow established/related connections
$IPT -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow SSH, HTTP, HTTPS
$IPT -A INPUT -p tcp --dport 22  -j ACCEPT
$IPT -A INPUT -p tcp --dport 80  -j ACCEPT
$IPT -A INPUT -p tcp --dport 443 -j ACCEPT

# ICMP — allow ping but not flooding
$IPT -A INPUT -p icmp --icmp-type echo-request -m limit --limit 10/s -j ACCEPT
$IPT -A INPUT -p icmp -j DROP

# Log and drop everything else
$IPT -A INPUT  -j LOG  --log-prefix "INPUT-DROP: "  --log-level 4
$IPT -A INPUT  -j DROP
$IPT -A FORWARD -j LOG --log-prefix "FORWARD-DROP: " --log-level 4
$IPT -A FORWARD -j DROP

# Persist
iptables-save > /etc/iptables/rules.v4
```

## nftables — Modern Production Ruleset

```nft
#!/usr/sbin/nft -f
# /etc/nftables.conf

flush ruleset

table inet filter {

  set blocklist {
    type ipv4_addr
    flags interval
    # populated dynamically by fail2ban or scripts
  }

  chain input {
    type filter hook input priority 0; policy drop;

    # Loopback
    iif lo accept

    # Block listed IPs immediately
    ip saddr @blocklist drop

    # Established/related
    ct state established,related accept

    # ICMP (rate-limited)
    icmp type echo-request limit rate 10/second accept
    icmpv6 type { echo-request, nd-neighbor-solicit } accept

    # Services
    tcp dport { 22, 80, 443 } accept

    # Log + drop remainder
    log prefix "nft-drop: " flags all
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

```bash
nft -c -f /etc/nftables.conf    # validate (dry-run)
nft -f /etc/nftables.conf       # apply
nft list ruleset                 # inspect running state
systemctl enable nftables        # persist across reboots
```

## fail2ban Integration

fail2ban watches log files and inserts temporary bans via iptables/nftables.

```ini
# /etc/fail2ban/jail.local — override defaults, never edit jail.conf
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd
banaction = iptables-multiport   # or nftables-multiport

[sshd]
enabled  = true
port     = ssh
maxretry = 3
bantime  = 24h

[nginx-http-auth]
enabled  = true
port     = http,https
logpath  = /var/log/nginx/error.log
maxretry = 5

[nginx-limit-req]
enabled  = true
port     = http,https
logpath  = /var/log/nginx/error.log
maxretry = 10
findtime = 1m
bantime  = 30m
```

```bash
systemctl enable --now fail2ban

# Inspect
fail2ban-client status              # all jails
fail2ban-client status sshd         # specific jail
fail2ban-client get sshd banip      # currently banned IPs

# Manual unban
fail2ban-client set sshd unbanip 203.0.113.42
```

## Firewall Audit Workflow

```bash
# 1. Verify from OUTSIDE (different machine or curl.sh)
nmap -p 22,80,443 your-server-ip            # should show open
nmap -p 5432,6379,9002,8080 your-server-ip  # should show filtered

# 2. Verify from INSIDE
ss -tlnp                                    # what is actually listening
ufw status verbose                          # active rules

# 3. Log review (what got dropped recently)
journalctl -k | grep "INPUT-DROP"
grep "nft-drop" /var/log/syslog | tail -50

# 4. Test rate limiting works
# From a controlled machine:
for i in $(seq 1 10); do ssh -o ConnectTimeout=2 user@server-ip 2>/dev/null; done
fail2ban-client status sshd   # verify ban applied
```

## Rule Precedence Reference

| Layer | Tool | Precedence |
|-------|------|-----------|
| kernel | nftables / iptables | Applied first — packets never reach the app if dropped here |
| kernel | Docker iptables rules | Docker inserts into `DOCKER-USER` chain; UFW cannot block Docker-exposed ports without extra steps |
| userspace | UFW | Wrapper around iptables; managed rules in `ufw-user-input` chain |
| userspace | fail2ban | Inserts bans into `fail2ban-*` chains above UFW rules |

**Docker + UFW warning:** Docker bypasses UFW for exposed ports by writing directly to iptables nat rules. Two mitigation options:

1. **Bind to localhost in compose** — `127.0.0.1:6333:6333` instead of `6333:6333`. Only works for services that don't need external access.

2. **DOCKER-USER chain** — For services that need selective external access (e.g. VPN-only), lock the chain instead:

```bash
# Allow only VPN subnet; drop all other external traffic to Docker ports
iptables -I DOCKER-USER -i eth0 '!' -s 10.0.0.0/24 -j DROP

# Verify — non-VPN DROP must be at position 1, before Docker's ACCEPT rules
iptables -L DOCKER-USER -n --line-numbers

# Remove lock
iptables -D DOCKER-USER -i eth0 '!' -s 10.0.0.0/24 -j DROP
```

The `-i eth0` scope is critical — without it the rule also drops Docker-internal traffic (container-to-container). Verify interface name with `ip link` (`eth0`, `ens3`, `enp3s0` vary by VPS).

## Checklist

- [ ] `ufw default deny incoming` confirmed before `ufw enable`
- [ ] SSH allowed before enabling UFW (or locked out)
- [ ] `ufw limit OpenSSH` — brute-force protection active
- [ ] Internal ports (5432, 6379, 9002) not reachable from outside (`nmap` confirms `filtered`)
- [ ] Docker exposed ports bound to `127.0.0.1` only
- [ ] `iptables-save` / `nft -f` persisted across reboots
- [ ] fail2ban enabled with sshd jail and tested
- [ ] Firewall audit run after every rule change (`nmap` from external host)
- [ ] Log prefix set for dropped packets — anomaly detection via journald
