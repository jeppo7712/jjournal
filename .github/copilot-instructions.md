# JJournal - AI Coding Instructions

JJournal is a self-hosted trading journal for stocks and futures: trades and day notes, price charts from Yahoo Finance, IBKR and TradingView, stats, and a cash ledger (Capital). This guide outlines the patterns that matter when changing the code.

## Architecture Overview

### Frontend (React 18, Create React App built via CRACO)
- Entry point: `src/App.jsx` holds the current view and which window (trade form, trade view, day note) is open
- Components live in `src/components/<Feature>/`, each with its own CSS module; shared pieces in `src/components/common/`
- State shared through contexts in `src/context/`: `TradeContext` (trades, day notes, accounts), `StatusContext` (server status lights), `TagsContext`, `BrokerAlertsContext` (IBKR items waiting)
- Helpers in `src/utils/`; money is formatted with `formatMoney.js` (minus on every negative, never a plus), timeframes shown with `timeframeLabel()` (1m/5m/15m, never the raw 1M/5M/15M codes)
- Colours come from the CSS variables in `src/styles.css` (`--ui-*`), with light-theme values under `[data-theme=light]`; don't hard-code colours

### Backend (Node.js/Express)
- Entry point: `server.js` sets up the API, the WebSocket status channel and the background schedulers
- Route modules in `routes/`, each a function `(dependencies) => router`, mounted under `/api`
- The external API lives under `/api/external/v1` (`routes/external.js`, documented in `EXTERNAL_API.md`)
- Database access and the schema (created and migrated on startup) in `modules/database.js`
- Background price-history fetching through a priority queue in `modules/task-manager.js` and `modules/historical-data-service.js`
- IBKR: `modules/ibkr-conn.js` (TWS/IB Gateway), `routes/ibkrFlex.js` and `modules/brokerCash.js` / `modules/brokerFills.js` (Flex Web Service)
- Trade P&L and cash settlement: `modules/tradeCalculations.js`, `modules/tradeSettlement.js`; Capital's design: `docs/CAPITAL_TRACKING_DESIGN.md`

## Key Patterns

- Internal routes need an `X-Account-ID` header; the external API doesn't
- The server pushes status and progress over WebSocket (`broadcastStatus` in `server.js`)
- Task priorities (lower runs first): `USER_FOREGROUND_YAHOO` < `USER_FOREGROUND_IBKR` < `USER_BACKGROUND_YAHOO` < `USER_BACKGROUND_IBKR` < `CRON_FULL_POPULATION`
- Money is kept per currency (the symbol's currency) and never summed across currencies

## Development Workflow

```bash
npm start       # API (port 3999) and the CRA dev server (port 3000) together
npm run server  # API only
npm run app     # frontend only
npm test        # unit tests (node --test test/*.test.js)
```

### Configuration
- Settings are saved from the app's Settings page into `config.json`, in the folder named by the `USER_PATH` environment variable (default: the project folder); it holds secrets and is git-ignored
- `.env.development` (git-ignored) can set `REACT_APP_API_URL` when the frontend and API run on different hosts, see `docs/SETUP.md`
- Logging through Winston (`modules/logger.js`) to `server.log`, `server-error.log` and `cron.log` next to `config.json`

## Public repository

This repository is public. Never put real account names or IDs, amounts, prices, dates or symbols from someone's own trading into code, comments, tests, docs or commit messages: invent example values (made-up tickers such as `ABC` or `ETFA.DE`, account IDs such as `U1000001`).
