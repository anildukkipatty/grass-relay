# Droplet Optimisation Plan — grass-relay

Target: DigitalOcean droplet, 8 GB RAM, 2 vCPU, Ubuntu 22.04/24.04.  
Goal: maximise concurrent WebSocket (GRASS) and SSE (app) connections while keeping the process reliable.

The relay is a pure proxy — no computation per message. The bottlenecks in order are:

1. **File descriptors** — every connection is one fd; the default cap is 1,024.
2. **TCP socket buffers** — kernel defaults waste RAM on large per-socket buffers.
3. **PM2 process supervision** — the current config needs a few reliability tweaks.
4. **Node.js flags** — minor gains for a long-lived single-process server.

RAM and CPU are not constraints at this scale. Address the items below in order.

---

## 1. Raise the file descriptor limit

This is the single most important change. Without it you hit a hard wall at ~1,000 connections.

```bash
# /etc/security/limits.conf — add these two lines
*    soft  nofile  1048576
*    hard  nofile  1048576
root soft  nofile  1048576
root hard  nofile  1048576
```

Also raise the system-wide kernel limit:

```bash
# /etc/sysctl.d/99-relay.conf
fs.file-max = 1048576
```

Apply without rebooting:

```bash
sudo sysctl -p /etc/sysctl.d/99-relay.conf
```

Log out and back in (or reboot) for `limits.conf` to take effect. Verify:

```bash
ulimit -n          # should print 1048576
cat /proc/sys/fs/file-max
```

**Expected result:** removes the fd ceiling; RAM then becomes the practical limit (~200k–400k idle connections on 8 GB).

---

## 2. Tune TCP kernel parameters

```bash
# /etc/sysctl.d/99-relay.conf  (add to the file above)

# Allow fast reuse of TIME_WAIT sockets
net.ipv4.tcp_tw_reuse = 1

# Shrink per-socket kernel buffers (default 87380/212992 bytes — huge for a proxy)
# 4 KB read + 4 KB write is plenty for relay traffic
net.ipv4.tcp_rmem = 4096 4096 16384
net.ipv4.tcp_wmem = 4096 4096 16384
net.core.rmem_default = 4096
net.core.wmem_default = 4096

# Increase the connection backlog for the listen socket
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535

# Keep idle connections alive and detect dead clients faster
net.ipv4.tcp_keepalive_time    = 60
net.ipv4.tcp_keepalive_intvl   = 10
net.ipv4.tcp_keepalive_probes  = 6
```

Apply:

```bash
sudo sysctl -p /etc/sysctl.d/99-relay.conf
```

**Expected result:** smaller per-socket kernel memory (~8 KB vs ~300 KB default) means 8 GB comfortably holds 200k+ sockets. Dead clients get detected within ~2 minutes instead of the 2-hour default.

---

## 3. Update `ecosystem.config.js`

```js
require("dotenv").config();

module.exports = {
  apps: [
    {
      name: "grass-relay",
      script: "./dist/index.js",

      // Single instance — the relay uses a shared in-memory session Map,
      // so cluster mode would break session routing across workers.
      instances: 1,

      autorestart: true,
      watch: false,

      // Restart if RSS exceeds 6 GB (leaves 2 GB headroom for the OS).
      max_memory_restart: "6G",

      // Raise the fd limit for the PM2-spawned process.
      // Requires the system limits.conf change in step 1 to be in place first.
      node_args: "--max-old-space-size=6144",

      env: {
        NODE_ENV: "production",
        UV_THREADPOOL_SIZE: "4",   // libuv thread pool; DNS/fs calls, not WS
      },

      // Graceful shutdown: let in-flight SSE streams drain before killing.
      kill_timeout: 10000,
      listen_timeout: 5000,

      // Log rotation — prevents disk fill on a busy relay.
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
    },
  ],
  deploy: {
    prod: {
      user: process.env.DEPLOY_USER,
      host: process.env.DEPLOY_HOST,
      ref: process.env.DEPLOY_REF,
      repo: "git@github.com:anildukkipatty/grass-relay.git",
      path: process.env.DEPLOY_PATH,
      "post-deploy": "bash run.sh",
    },
  },
};
```

Key changes from the original:
- `max_memory_restart` raised from 4 GB to 6 GB — the old value was too conservative for a high-connection relay and could cause unnecessary restarts.
- `kill_timeout: 10000` — gives active SSE connections 10 seconds to drain on reload/restart instead of being hard-killed immediately.
- `node_args: --max-old-space-size=6144` — prevents V8 from GC-thrashing when holding many session objects in the heap.

---

## 4. PM2 startup and log rotation

Make PM2 survive reboots and prevent log files from filling the disk:

```bash
# Install PM2 log rotation module
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 5
pm2 set pm2-logrotate:compress true

# Register PM2 as a systemd service so it starts on boot
pm2 startup systemd
# Run the command it prints, then:
pm2 save
```

---

## 5. Optional — place a reverse proxy in front (Nginx or Caddy)

If you add TLS termination, an Nginx or Caddy reverse proxy in front of PM2 buys:
- TLS offload (Node.js TLS is slower than Nginx's)
- Nginx can handle the connection backlog before handing off to Node
- `proxy_read_timeout` and `proxy_send_timeout` tuning per connection type

Minimal Nginx config for WebSocket + SSE pass-through:

```nginx
upstream relay {
    server 127.0.0.1:4000;
    keepalive 512;          # persistent upstream connections to Node
}

server {
    listen 443 ssl;
    # ... TLS config ...

    # Raise Nginx's own worker_rlimit_nofile as well
    # (set in /etc/nginx/nginx.conf: worker_rlimit_nofile 1048576;)

    location / {
        proxy_pass http://relay;
        proxy_http_version 1.1;

        # Required for WebSocket upgrade
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Required for SSE — disable buffering so chunks flush immediately
        proxy_buffering off;
        proxy_cache off;

        # Keep SSE connections alive for up to 1 hour
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

And in `/etc/nginx/nginx.conf`:

```nginx
worker_processes auto;          # matches vCPU count
worker_rlimit_nofile 1048576;
events {
    worker_connections 65536;
    use epoll;
    multi_accept on;
}
```

---

## Expected capacity after all changes

| Scenario | Concurrent connections |
|---|---|
| Untuned (default ulimit 1024) | ~1,000 |
| After step 1 (fd limit) only | ~200,000 (RAM-limited) |
| After steps 1–3 (fd + TCP tuning) | ~300,000–400,000 idle |
| With Nginx in front | same Node limit; Nginx adds no meaningful overhead |

The relay holds ~17–20 KB RSS per idle GRASS WebSocket session. With 8 GB, ~400k sessions fit in RAM once kernel socket buffers are tightened. In practice, GRASS sessions carrying active SSE subscribers will use more — budget ~50–100 KB per busy session — so a realistic comfortable operating point is **20,000–50,000 concurrent active sessions** with headroom to spare.

---

## Checklist

- [ ] `/etc/security/limits.conf` — raise `nofile` to 1048576
- [ ] `/etc/sysctl.d/99-relay.conf` — TCP buffer, backlog, keepalive tuning
- [ ] Reboot (or `sysctl -p` + re-login) and verify `ulimit -n`
- [ ] Update `ecosystem.config.js` with new PM2 settings
- [ ] `pm2 install pm2-logrotate` and configure retention
- [ ] `pm2 startup systemd` + `pm2 save`
- [ ] (Optional) Nginx reverse proxy for TLS + SSE buffer tuning
