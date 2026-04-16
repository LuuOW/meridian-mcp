---
name: port-scanner
description: nmap and masscan recipes for host discovery, open port enumeration, service fingerprinting, and firewall validation on VPS deployments
---

# port-scanner

Targeted nmap and masscan patterns for validating firewall posture, discovering open services, and fingerprinting what is actually exposed on a host. Use after provisioning a VPS to confirm only intended ports are reachable.

## 1) Common nmap Recipes

```bash
# Quick scan — top 1000 TCP ports
nmap -F target-ip

# All TCP ports
nmap -p- target-ip

# With service version detection
nmap -sV -p 22,80,443,8080 target-ip

# OS detection + service version (requires root)
sudo nmap -O -sV target-ip

# Aggressive scan (OS, version, scripts, traceroute)
sudo nmap -A target-ip

# Scan a subnet
nmap -sn 192.168.1.0/24          # ping sweep (no port scan)
nmap 192.168.1.0/24              # port scan all hosts

# UDP scan (slow — limit to key ports)
sudo nmap -sU -p 53,123,161 target-ip

# Save output
nmap -oN scan.txt target-ip     # normal
nmap -oG scan.grep target-ip    # greppable
nmap -oX scan.xml target-ip     # XML (for scripted parsing)
```

## 2) Firewall Validation

```bash
# Confirm only expected ports open from the outside
# Run from a different machine, not localhost
nmap -p 22,80,443 your-vps-ip

# Verify internal ports are NOT reachable from outside
# These should all show filtered:
nmap -p 5432,6379,9002,8080 your-vps-ip

# Check if a specific port is filtered vs closed
nmap -p 3306 --reason your-vps-ip
# "filtered" = firewall dropping packets (good)
# "closed"   = no firewall, just nothing listening (less good)
```

## 3) masscan (High-Speed)

```bash
# Install
apt install masscan

# Scan entire internet space on port 80 (rate-limited)
sudo masscan -p80 0.0.0.0/0 --rate=100000 --exclude 255.255.255.255

# Scan a range quickly
sudo masscan -p22,80,443 192.168.1.0/24 --rate=1000

# Output to JSON
sudo masscan -p80,443 10.0.0.0/8 --rate=500 -oJ output.json
```

## 4) nmap Scripting Engine (NSE)

```bash
# Check for known vulnerabilities
nmap --script vuln target-ip

# HTTP title and server header
nmap --script http-title,http-server-header -p 80,443,8080 target-ip

# Check SSL cert details
nmap --script ssl-cert -p 443 target-ip

# Detect open proxies
nmap --script http-open-proxy -p 8080 target-ip

# Banner grabbing
nmap --script banner -p 22,25,110 target-ip

# SSH auth methods
nmap --script ssh-auth-methods -p 22 target-ip
```

## 5) Quick Cheatsheet

| Goal | Command |
|---|---|
| What's open (fast) | `nmap -F <ip>` |
| All TCP ports | `nmap -p- <ip>` |
| Service versions | `nmap -sV -p- <ip>` |
| Firewall check | `nmap -p <port> --reason <ip>` |
| UDP top ports | `sudo nmap -sU --top-ports 20 <ip>` |
| Subnet sweep | `nmap -sn 192.168.1.0/24` |
| SSL cert check | `nmap --script ssl-cert -p 443 <ip>` |
| Vuln scan | `nmap --script vuln <ip>` |

## 6) Checklist

- [ ] Run external scan after every firewall rule change to confirm posture
- [ ] Internal ports (5432, 6379, 9002, etc.) show `filtered` from outside
- [ ] Only 22, 80, 443 show `open` from outside
- [ ] SSL cert confirmed with `nmap --script ssl-cert`
- [ ] Save baseline scan to compare after infra changes: `nmap -oN baseline.txt`
