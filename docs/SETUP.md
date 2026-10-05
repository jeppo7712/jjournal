# Setup Guide

## 1. Get a PostgreSQL database

Any reachable Postgres instance works — local, Docker, a NAS, a managed service. The app only needs an empty database and a user that can create tables in it; it creates and migrates its own schema automatically the first time it connects.

```sql
CREATE DATABASE jjournal;
CREATE USER jjournal WITH PASSWORD 'choose-a-password';
GRANT ALL PRIVILEGES ON DATABASE jjournal TO jjournal;
```

You'll end up with a connection string like:

```
postgresql://jjournal:choose-a-password@your-db-host:5432/jjournal
```

## 2. Run the app

### Option A — Docker (recommended)

```bash
docker build -t jjournal .
docker run -d \
  --restart unless-stopped \
  -p 3999:3999 \
  -v jjournal_data:/user_data \
  --name jjournal \
  jjournal
```

- `/user_data` holds `config.json` (your saved settings) and log files — mount it so they survive container recreation.
- `--restart unless-stopped` is needed: saving a new database URL or port in Settings restarts the app by exiting the process, and Docker only starts it again with a restart policy. It also brings the app back after a host reboot. If Postgres isn't reachable yet when the app starts, the app keeps running and retries the connection every 30 seconds.
- Trade/day-note screenshot attachments are stored in PostgreSQL, so they're covered by your database backups; no extra volume is needed for them.
- The container serves both the API and the built frontend on port `3999` — that's the only port you need to expose.

### Option B — Manual / local dev

Requires Node.js 22+.

```bash
npm install
npm start   # runs the Express API and the CRA dev server together
```

- The API runs on port `3999`, the CRA dev server on `3000` — open `http://localhost:3000` while developing.
- If your frontend and backend run on different hosts/ports (e.g. Docker Compose with a bind mount, or a remote dev box), set `REACT_APP_API_URL` in a `.env.development` file in the project root (git-ignored) to the backend's actual address, e.g.:
  ```
  REACT_APP_API_URL=http://192.168.1.50:3999
  ```
  Without this, chart data will load (proxied through CRA) but the WebSocket status/progress connection will silently fail to connect, since it can't be proxied the same way.

## 3. First-run configuration

Open the app and go to **Settings**:

1. **Database** — paste your `postgresql://...` connection string. On save, the app tests the connection, then creates/migrates its schema. No manual SQL beyond step 1 is needed.
2. **IBKR (optional)** — if you run TWS or IB Gateway:
   - In TWS/Gateway: enable the API (**Configuration → API → Settings → Enable ActiveX and Socket Clients**), and add the app's host to **Trusted IPs** if it's not running on the same machine.
   - In the app's Settings: enter the host/port (default paper-trading port is `7497`, live is `7496`). A second address can be set as a fallback.
   - Without IBKR connected, the app still works fully off Yahoo Finance — you'll just miss IBKR's higher-quality data and Flex Web Service imports.
3. **IBKR Flex Web Service (optional)** — for importing trades directly from IBKR, and optionally the account's cash activity (fees, interest, dividends, deposits): generate a Flex Web Service token and the Flex Queries in IBKR's Client Portal, and paste the token + query IDs into Settings → IBKR API. That page has a step-by-step guide to what to tick in IBKR's Flex Query editor, and a **Check** button that tests the saved queries and says what's missing.
4. **Symbols** — add each symbol you trade (Settings → Symbols), including tick size/value, fees, exchange, and which timeframes to fetch. Every enabled timeframe is fetched as far back as the provider allows — no need to guess how much history to request.

## 4. Verify it's working

Add a trade for a symbol you've configured, open its chart, and watch the server logs (or the in-app status indicator) for a fetch task completing. If IBKR is connected, you'll see both a Yahoo and an IBKR fetch attempt; if not, only Yahoo.

## Troubleshooting

- **WebSocket status/progress indicator never connects in dev mode** — see the `REACT_APP_API_URL` note under Option B above.
- **IBKR contract errors ("No security definition has been found")** — usually a currency/exchange mismatch for that symbol (e.g. a non-USD stock). Double-check the exchange configured for that symbol matches what IBKR expects (IBKR's own exchange codes, not always the plain-English name).
- **Historical fetch seems stuck on one symbol for a long time** — normal for 1-minute bars on IBKR: they're chunked 7 days at a time with IBKR's own pacing delay between requests, and "as far back as possible" for a liquid, long-listed symbol can mean walking back years of chunks. It only pays this cost once per symbol/timeframe — once IBKR's real limit is discovered, it's cached and every future run skips straight past it.
- **HIS light red (IBKR historical data not answering)** — IB Gateway can stay connected while answering no historical requests, e.g. after it reconnects to IBKR's servers; restarting it fixes that. If the gateway runs with [IBC](https://github.com/IbcAlpha/IBC), the app can ask it to reconnect by itself: enable IBC's command server (`CommandServerPort=7462`, and `ControlFrom=` this app's host name) and enter the gateway's host and that port under **Settings → TWS → Gateway auto-reconnect**. After two failed requests in a row it then sends `RECONNECTDATA`, at most every 15 minutes. Only enable the command server where nothing but this app can reach it: it also accepts commands such as `STOP`.
- **No data at all for a symbol** — check `GET /api/historical/limits?symbol=...&type=...` (or the Settings page) to see what's been discovered so far, and check the server log for the specific fetch error.

## Where things live

| What | Where |
|---|---|
| App settings, IBKR/DB config | `config.json` (path controlled by `USER_PATH` env var, default `./`) |
| Logs | `server.log`, `server-error.log`, `cron.log` next to `config.json` |
| Trade/day-note attachments | your PostgreSQL database (`Uploads/` only holds upload temp files) |
| Everything else (trades, journal entries, price history) | your PostgreSQL database |

See also **[EXTERNAL_API.md](../EXTERNAL_API.md)** if you want another tool (e.g. an AI trade-analysis script) to read/write this data.
