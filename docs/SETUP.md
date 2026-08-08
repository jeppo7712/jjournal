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
  -p 3999:3999 \
  -v jjournal_data:/user_data \
  -v jjournal_uploads:/app/Uploads \
  --name jjournal \
  jjournal
```

- `/user_data` holds `config.json` (your saved settings) and log files — mount it so they survive container recreation.
- `/app/Uploads` holds trade/day-note screenshot attachments — mount it too, or they're lost on recreation.
- The container serves both the API and the built frontend on port `3999` — that's the only port you need to expose.

### Option B — Manual / local dev

Requires Node.js 20+.

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
3. **IBKR Flex Web Service (optional)** — for importing trade activity/executions directly from IBKR: generate a Flex Web Service token and a Flex Query (Activity or Trade Confirmation) in IBKR Account Management, and paste the token + query ID(s) into Settings.
4. **Symbols** — add each symbol you trade (Settings → Symbols), including tick size/value, fees, exchange, and which timeframes to fetch. Every enabled timeframe is fetched as far back as the provider allows — no need to guess how much history to request.

## 4. Verify it's working

Add a trade for a symbol you've configured, open its chart, and watch the server logs (or the in-app status indicator) for a fetch task completing. If IBKR is connected, you'll see both a Yahoo and an IBKR fetch attempt; if not, only Yahoo.

## Troubleshooting

- **WebSocket status/progress indicator never connects in dev mode** — see the `REACT_APP_API_URL` note under Option B above.
- **IBKR contract errors ("No security definition has been found")** — usually a currency/exchange mismatch for that symbol (e.g. a non-USD stock). Double-check the exchange configured for that symbol matches what IBKR expects (IBKR's own exchange codes, not always the plain-English name).
- **Historical fetch seems stuck on one symbol for a long time** — normal for 1-minute bars on IBKR: they're chunked 7 days at a time with IBKR's own pacing delay between requests, and "as far back as possible" for a liquid, long-listed symbol can mean walking back years of chunks. It only pays this cost once per symbol/timeframe — once IBKR's real limit is discovered, it's cached and every future run skips straight past it.
- **No data at all for a symbol** — check `GET /api/historical/limits?symbol=...&type=...` (or the Settings page) to see what's been discovered so far, and check the server log for the specific fetch error.

## Where things live

| What | Where |
|---|---|
| App settings, IBKR/DB config | `config.json` (path controlled by `USER_PATH` env var, default `./`) |
| Logs | `server.log`, `server-error.log`, `cron.log` next to `config.json` |
| Trade/day-note attachments | `Uploads/` in the app directory |
| Everything else (trades, journal entries, price history) | your PostgreSQL database |

See also **[EXTERNAL_API.md](../EXTERNAL_API.md)** if you want another tool (e.g. an AI trade-analysis script) to read/write this data.
