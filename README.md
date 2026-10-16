# Ravan Dahan (Dussehra game)

Everyone plays at the same time on their own screen. A live leaderboard ranks players by fastest time to burn Ravan.
The host approves who gets in and can run an optional team show on a shared screen.

## Run on a server

Needs Docker. No domain or HTTPS is required: plain `http://<public-ip>` works.
Open the port (80, or 8000) in the server firewall / security group.

```bash
git clone <your-repo-url> ravan-dahan && cd ravan-dahan
docker build -t ravan-dahan .
docker run -d --name ravan-dahan --restart unless-stopped \
  -p 80:8000 -e HOST_KEY=choose-a-long-secret \
  -v ravan-data:/app/data ravan-dahan
```

If port 80 is taken, use `-p 8000:8000` and add `:8000` to the links below.

Without Docker: `pip install aiohttp==3.9.5 && HOST_KEY=choose-a-long-secret PORT=8000 python server.py`

## Links

- Players: `http://<public-ip>/`
- Host: `http://<public-ip>/?host=<HOST_KEY>` (keep private)

## Event day

1. Open the host link first and keep it open. The entry panel is at the bottom-left.
2. Share the players link. Each person types a name and waits.
3. Press **Approve all** (or approve one by one, or tick **Auto-approve everyone**).
4. Optional finale: **Start live show** for a team battle on a shared screen.

## Notes

- Run a single instance. State lives in memory and in `data/state.json`.
- Set `AUTO_APPROVE=1` to skip approval by default.
- Browsers show "Not secure" over plain HTTP. The game still works.
- Optional HTTPS: Caddy (`your-domain.com { reverse_proxy localhost:8000 }`) handles WebSockets automatically. With nginx add `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`.
- Health check: `GET /healthz`.
