---
name: devops
description: General-purpose DevOps for VPS-based deployments — Nginx reverse proxy, SSL with Let's Encrypt, PM2 process management, systemd services, firewall rules, log rotation, monitoring, and backup strategies
keywords: ["devops", "general", "vps", "nginx", "ssl", "let", "encrypt", "pm2", "general-purpose", "vps-based", "deployments", "reverse", "proxy", "process", "management", "systemd", "services"]
orb_class: planet
---

# devops

Practical DevOps for self-hosted VPS deployments running Python/FastAPI + Node/Astro apps. Assumes Ubuntu 22.04/24.04, Docker optional.

## 1) VPS Initial Setup

```bash
# As root — first-time server setup
adduser deploy
usermod -aG sudo deploy
usermod -aG docker deploy   # if using Docker

# Copy SSH key
mkdir -p /home/deploy/.ssh
cat >> /home/deploy/.ssh/authorized_keys << 'EOF'
ssh-ed25519 AAAA... your-public-key
EOF
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh

# Harden SSH
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart sshd

# Firewall
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

## 2) Nginx Reverse Proxy

```nginx
# /etc/nginx/sites-available/myapp
server {
    listen 80;
    server_name myapp.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name myapp.example.com;

    ssl_certificate     /etc/letsencrypt/live/myapp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/myapp.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Frontend (Astro/Next on :8080)
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API (FastAPI on :9002)
    location /api/ {
        proxy_pass http://127.0.0.1:9002;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
    }

    # WebSocket / SSE
    location /api/stream {
        proxy_pass http://127.0.0.1:9002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }

    client_max_body_size 10M;
    gzip on;
    gzip_types text/plain application/json application/javascript text/css;
}
```

```bash
ln -s /etc/nginx/sites-available/myapp /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

## 3) SSL with Let's Encrypt

```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d myapp.example.com -d www.myapp.example.com

# Auto-renew (already set up by certbot, verify):
systemctl status certbot.timer
# Manual renew test:
certbot renew --dry-run
```

## 4) PM2 Process Management

```bash
npm install -g pm2

# Start services
pm2 start ecosystem.config.cjs --env production

# Persist across reboots
pm2 startup systemd -u deploy --hp /home/deploy
pm2 save

# Daily commands
pm2 status          # list all processes + CPU/mem
pm2 logs api        # tail logs for 'api' process
pm2 logs --lines 100
pm2 reload api      # zero-downtime reload (SIGINT → new process → old dies)
pm2 restart api     # hard restart (brief downtime)
pm2 monit           # real-time dashboard
```

```js
// ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "api",
      interpreter: "/opt/myapp/.venv/bin/python",
      script: "-m",
      args: "uvicorn app.main:app --host 0.0.0.0 --port 9002 --workers 2",
      cwd: "/opt/myapp",
      env_production: {
        ENVIRONMENT: "production",
        PYTHONUNBUFFERED: "1",
      },
      error_file: "/var/log/myapp/api-error.log",
      out_file:   "/var/log/myapp/api-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      max_memory_restart: "500M",
    },
    {
      name: "frontend",
      script: "node",
      args: "dist/server/entry.mjs",
      cwd: "/opt/myapp/frontend",
      env_production: { PORT: "8080", NODE_ENV: "production" },
      max_memory_restart: "300M",
    },
    {
      name: "worker",
      script: ".venv/bin/celery",
      args: "-A celery_app worker -Q default,scraping,api_calls --concurrency=2 --loglevel=info",
      cwd: "/opt/myapp",
      env_production: { ENVIRONMENT: "production" },
    },
  ],
};
```

## 5) systemd Service (alternative to PM2)

```ini
# /etc/systemd/system/myapp-api.service
[Unit]
Description=MyApp FastAPI
After=network.target postgresql.service

[Service]
User=deploy
WorkingDirectory=/opt/myapp
EnvironmentFile=/opt/myapp/.env.production
ExecStart=/opt/myapp/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 9002
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable myapp-api
systemctl start myapp-api
journalctl -u myapp-api -f   # follow logs
```

## 6) Log Rotation

```bash
# /etc/logrotate.d/myapp
/var/log/myapp/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    postrotate
        pm2 reloadLogs
    endscript
}
```

## 7) Monitoring (lightweight)

```bash
# Quick health check cron — sends Slack alert on failure
# /opt/myapp/scripts/healthcheck.sh
#!/bin/bash
URL="http://localhost:9002/health"
SLACK_WEBHOOK="${SLACK_WEBHOOK_URL_ALERTS}"

if ! curl -sf "$URL" > /dev/null; then
    curl -X POST "$SLACK_WEBHOOK" \
        -H 'Content-type: application/json' \
        --data "{\"text\": \":red_circle: myapp API health check failed at $(date)\"}"
fi
```

```bash
# Add to crontab (deploy user):
*/5 * * * * /opt/myapp/scripts/healthcheck.sh
```

**Disk / memory:**
```bash
df -h          # disk usage
free -h        # memory
htop           # real-time CPU/mem by process
docker stats   # container resource usage
```

## 8) Backup Strategy

```bash
# /opt/scripts/backup-db.sh
#!/bin/bash
set -e
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/opt/backups/postgres"
mkdir -p "$BACKUP_DIR"

pg_dump "$DATABASE_URL" | gzip > "$BACKUP_DIR/myapp_${DATE}.sql.gz"

# Keep last 7 days
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +7 -delete

echo "Backup complete: myapp_${DATE}.sql.gz"
```

```bash
# Cron — daily at 3am:
0 3 * * * /opt/scripts/backup-db.sh >> /var/log/myapp/backup.log 2>&1
```

## 9) Port Reference

| Service | Default Port | Notes |
|---|---|---|
| Nginx HTTP | 80 | Redirects to 443 |
| Nginx HTTPS | 443 | Terminates SSL |
| FastAPI / uvicorn | 9002 | Internal only |
| Astro / Next.js | 8080 | Internal only |
| PostgreSQL | 5432 | localhost only (never expose) |
| Redis | 6379 | localhost only |
| Celery Flower | 5555 | Block with auth if exposed |

**Rule:** Only 80 and 443 open in firewall. All other ports bind to `127.0.0.1` only.

## 10) Checklist

- [ ] SSH password auth disabled, key-only login
- [ ] `ufw` enabled — only 22/80/443 open
- [ ] Nginx terminates SSL, proxies to internal ports
- [ ] Internal ports (9002, 8080, 5432, 6379) bound to `127.0.0.1` only
- [ ] PM2 / systemd persists across reboots (`pm2 startup && pm2 save`)
- [ ] Log rotation configured — no unbounded log growth
- [ ] Daily DB backup with 7-day retention
- [ ] Health check cron running every 5 minutes
- [ ] `certbot renew` auto-timer verified (`systemctl status certbot.timer`)
- [ ] `.env.production` readable only by deploy user (`chmod 600`)
