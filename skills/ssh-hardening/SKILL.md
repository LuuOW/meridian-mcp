---
name: ssh-hardening
description: SSH daemon hardening fragments — sshd_config directives, key-only auth, port and user restrictions, agent forwarding policy, and authorized_keys access control patterns
keywords: ["ssh", "hardening", "daemon", "fragments", "sshd", "config", "directives", "key-only", "auth", "port", "user", "restrictions", "agent", "forwarding", "policy"]
orb_class: comet
---

# ssh-hardening

Minimal SSH hardening patterns. Apply to any Linux server immediately after provisioning. These are configuration fragments — combine with firewall rules and fail2ban for a complete posture.

## sshd_config Hardened Baseline

```bash
# /etc/ssh/sshd_config.d/99-hardening.conf
# Drop-in override — survives package upgrades better than editing sshd_config directly

# Disable password auth — key-only
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no

# Disable root login entirely
PermitRootLogin no

# Only named users can SSH in
AllowUsers deploy ci-agent

# Disable legacy and dangerous features
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
PermitTunnel no

# Enforce protocol and key type minimums
Protocol 2
HostKeyAlgorithms ssh-ed25519,rsa-sha2-512,rsa-sha2-256
PubkeyAcceptedAlgorithms ssh-ed25519,rsa-sha2-512,rsa-sha2-256

# Timeout idle sessions
ClientAliveInterval 300
ClientAliveCountMax 2
LoginGraceTime 30

# Limit authentication attempts per connection
MaxAuthTries 3

# Restrict to specific port (obscures in logs; not a security control)
# Port 2222
```

```bash
# Validate and reload
sshd -t                          # syntax check (no restart)
systemctl reload ssh
```

## Key Management

```bash
# Generate ed25519 key (preferred — smaller, faster, same security as RSA-4096)
ssh-keygen -t ed25519 -C "deploy@$(hostname)" -f ~/.ssh/id_ed25519

# RSA fallback (for older servers that don't support ed25519)
ssh-keygen -t rsa -b 4096 -C "deploy@$(hostname)" -f ~/.ssh/id_rsa

# Install public key on remote host
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@remote-host

# Manual install (when ssh-copy-id isn't available)
cat ~/.ssh/id_ed25519.pub | ssh user@remote-host \
  'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

## authorized_keys Restrictions

```bash
# ~/.ssh/authorized_keys — one line per key, options prefix restricts what the key can do

# Fully restricted key: runs only one command, no forwarding, IP-limited
from="203.0.113.0/24",command="/opt/scripts/deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA...

# CI/CD key: command-restricted, no TTY
command="/opt/scripts/ci-commands.sh",no-pty,no-port-forwarding ssh-ed25519 AAAA...

# Regular admin key: IP-restricted only
from="10.8.0.0/24" ssh-ed25519 AAAA...
```

```bash
# Audit: list all authorized keys on the system
find /home /root -name authorized_keys -exec echo "=== {} ===" \; -exec cat {} \;
```

## SSH Config for Jump Hosts

```ini
# ~/.ssh/config — client-side configuration
Host bastion
    HostName bastion.example.com
    User deploy
    IdentityFile ~/.ssh/id_ed25519
    StrictHostKeyChecking yes

# Reach internal servers via bastion
Host internal-*
    ProxyJump bastion
    User deploy
    IdentityFile ~/.ssh/id_ed25519
    StrictHostKeyChecking yes

Host internal-db
    HostName 10.0.0.5
```

## Checklist

- [ ] `PasswordAuthentication no` confirmed (`ssh user@host` with wrong key shows "Permission denied (publickey)`)
- [ ] `PermitRootLogin no`
- [ ] `AllowUsers` limits login to named accounts only
- [ ] `X11Forwarding no` and `AllowAgentForwarding no`
- [ ] Authorized keys audited — no unrecognized entries
- [ ] Restricted `authorized_keys` options on service/CI keys (command=, no-pty, etc.)
- [ ] `sshd -t` passes after every config change before reload
