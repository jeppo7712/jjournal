# External API (v1)

A read/write API for external tools — an AI trade-analysis project, a script, whatever — to consume this journal's data: accounts (including capital allocation/cash balance and paper-vs-real), trades (with computed side/status/PnL/return%), a cash ledger and non-trade holdings (T-bills/bonds), day notes, attachments, symbol settings, and historic/current prices. It also has one narrow write-back endpoint so an external tool can attach its analysis to a trade.

Base URL: `http://<host>:<port>/api/external/v1`

Implementation: `routes/external.js`. Trade PnL/status calculations: `modules/tradeCalculations.js`.

## Authentication

**None.** This is a deliberate product decision, not an oversight. Anyone who can reach this server can read your entire trade history and write AI analysis onto trades.

If this server is ever reachable outside a network you trust, put it behind a reverse proxy, VPN, or firewall rule — don't expose it directly to the internet. All external-API routes live under the single `/api/external/v1` prefix and are mounted independently of the internal app API, specifically so an auth middleware (API key, bearer token, whatever) can be dropped in front of just this prefix later without touching anything else.

## Conventions

- All responses are JSON.
- All timestamps are ISO 8601 in UTC (e.g. `2026-03-14T13:45:00.000Z`).
- Money fields are plain numbers (no currency symbol), in account currency.
- Paginated list endpoints (`trades`, `daynotes`, `accounts/:id/cash-transactions`, `holdings`) return an object with a `total` count, `limit`, `offset`, and the array under a named key, not a bare array. Non-paginated list endpoints (`accounts`, `symbols`) return just the named key — no `total` field, since there's nothing to paginate.
- Errors are `{ "error": "message" }` with a non-2xx status code.
- `GET /api/external/v1/` returns a small discovery document listing every endpoint.

---

## GET /accounts

List all accounts.

```json
{
  "accounts": [
    {
      "id": 1,
      "name": "Main",
      "parent_account_id": null,
      "is_virtual": false,
      "created_at": "...",
      "updated_at": "...",
      "cash_balances": [
        { "currency": "USD", "balance": 8082.84 },
        { "currency": "EUR", "balance": 165.92 }
      ]
    }
  ]
}
```

Field notes:
- `is_virtual`: paper/simulated vs. real money, permanently, for the whole account — never per-transaction (see `GET /accounts/:id/cash-transactions` below).
- `parent_account_id`: non-`null` when this account represents part of the same real broker account as another (e.g. a combined stocks+futures IBKR account split into two journal accounts by instrument type). Trades are **not** shared between parent/child — only cash.
- `cash_balances`: **rolled up** — includes this account's own cash plus every descendant account's (recursively), per currency, never summed across currencies without an FX rate. For an account with no children this is just its own balance.

---

## GET /accounts/:id/cash-transactions

The cash ledger for one account — deposits, withdrawals, transfers, currency exchanges, trade settlements, interest. Rolled up the same way `cash_balances` above is: includes `:id`'s own rows plus every descendant account's.

### Query parameters

| Param | Type | Description |
|---|---|---|
| `from` / `to` | ISO date/time | Filters on `date_time`. |
| `limit` | int | Default 200, max 1000. |
| `offset` | int | Default 0. |

### Response

```json
{
  "total": 3,
  "limit": 200,
  "offset": 0,
  "cash_transactions": [
    {
      "id": 10,
      "account_id": 7,
      "account_name": "IB Stocks",
      "date_time": "2026-05-01T00:00:00.000Z",
      "type": "DEPOSIT",
      "amount": "7582.84",
      "currency": "USD",
      "linked_trade_id": null,
      "linked_holding_id": null,
      "transfer_pair_id": null,
      "note": "Initial deposit"
    }
  ]
}
```

`type` is one of `DEPOSIT`, `WITHDRAWAL`, `TRANSFER_IN`, `TRANSFER_OUT`, `EXCHANGE_IN`, `EXCHANGE_OUT`, `TRADE_SETTLEMENT`, `INTEREST`, `OTHER`. `amount` is signed (positive = cash in). `account_name` tells you which physical account a row actually belongs to when it isn't `:id` itself (i.e. it came from a descendant). `404` if `:id` doesn't exist.

---

## GET /holdings

Non-trade holdings — T-bills, bonds, other fixed income. Separate from `trades` since these don't have live quotes or buy/sell-fill PnL; they mature or get sold/redeemed instead.

### Query parameters

| Param | Type | Description |
|---|---|---|
| `account_id` | int | Restrict to one account (rolled up across descendants, like the ledger above). Omit for **all** accounts. |
| `status` | string | Comma-separated: `ACTIVE,MATURED,SOLD`. |
| `limit` | int | Default 200, max 1000. |
| `offset` | int | Default 0. |

### Response

```json
{
  "total": 1,
  "limit": 200,
  "offset": 0,
  "holdings": [
    {
      "id": 2,
      "account_id": 10,
      "account_name": "IB FUT Live 2026",
      "type": "TBILL",
      "name": "US T-Bill 13w",
      "currency": "USD",
      "face_value": "1000.00",
      "purchase_price": "990.00",
      "purchase_date": "2026-01-01",
      "maturity_date": "2026-04-01",
      "coupon_rate": null,
      "coupon_frequency": null,
      "status": "ACTIVE",
      "notes": null,
      "total_interest_earned": 0,
      "implied_annual_yield_percent": 6.11
    }
  ]
}
```

`type` is `TBILL`, `BOND`, or `OTHER`. When `coupon_rate`/`coupon_frequency` are `null`, treat `purchase_price` as the current value — no accrual is modeled until something actually posts (see below); this is the normal case for a `TBILL`, which is a discount instrument with no periodic coupon at all.

"How much is this actually earning" — two computed fields, not stored columns:
- `total_interest_earned`: realized coupon income to date (sum of this holding's `INTEREST`-type cash_transactions — see below). Excludes the maturity payout itself, which is principal (`type: "OTHER"`), not interest. Always `0` for a holding with no coupon (e.g. a `TBILL`).
- `implied_annual_yield_percent`: only computed when `coupon_rate` is null/0 and `maturity_date` is set — the annualized yield a discount instrument like a `TBILL` is priced to return if held to maturity, `(face_value − purchase_price) / purchase_price`, annualized by actual days between `purchase_date` and `maturity_date`. `null` for a `BOND` — `coupon_rate` already answers this directly there.

A background job (also triggerable via the internal `POST /holdings/process-accrual`) automatically posts `BOND` coupon payments as they come due (visible in `GET /accounts/:id/cash-transactions` as `type: "INTEREST"` rows with `linked_holding_id` set), and auto-redeems any holding at face value once `maturity_date` passes (`status` flips to `MATURED`, plus a `type: "OTHER"` credit row). A holding's `purchase_price`/`status` won't reflect this until whichever of those actually happens — there's no running "accrued but not yet posted" estimate.

---

## GET /trades

List trades across one or all accounts, with computed fields included so you don't have to reimplement FIFO PnL/side/status logic yourself.

### Query parameters

| Param | Type | Description |
|---|---|---|
| `account_id` | int | Restrict to one account. Omit to get trades across **all** accounts. |
| `symbol` | string | Exact symbol match (e.g. `MNQ`, `AAPL`). |
| `type` | `STK` \| `FUT` | Filter by instrument type. |
| `status` | string | Comma-separated: `OPEN,WIN,LOSS,WASH`. A trade is `OPEN` while a position remains, or resolves to `WIN`/`LOSS`/`WASH` once fully closed (fully closed with ~$0 realised PnL is `WASH`, not `WIN`/`LOSS`). |
| `from` / `to` | ISO date/time | Filters on the trade's **first action date** (when it was actually opened), not `created_at` (when the row was saved). |
| `limit` | int | Default 200, max 1000. |
| `offset` | int | Default 0. |

### Response

```json
{
  "total": 542,
  "limit": 200,
  "offset": 0,
  "trades": [ { /* trade object, see below */ } ]
}
```

### Trade object

```json
{
  "id": 4821,
  "account_id": 1,
  "account_name": "Main",
  "type": "FUT",
  "symbol": "MNQ",
  "contract_month": "202506",
  "target": 21050.5,
  "stop_loss": 20980.0,
  "tick_size": 0.25,
  "tick_value": 0.5,
  "created_at": "2026-05-12T14:02:11.000Z",
  "updated_at": "2026-05-12T14:02:11.000Z",

  "actions": [
    { "type": "BUY", "date_time": "2026-05-12T14:00:00.000Z", "quantity": 2, "price": 21001.25, "fee": 1.24, "exec_id": "0001f4e3.6819.01.01" }
  ],

  "journal": {
    "tags": "breakout,news",
    "notes_html": "<p>Entered on the 5m breakout...</p>",
    "confidence": 4,
    "execution_rating": 3,
    "ai_analysis": "This trade caught a clean breakout but the stop was tight relative to recent ATR...",
    "ai_analysis_source": "hermes-gpt5",
    "ai_analysis_updated_at": "2026-05-13T09:10:00.000Z"
  },

  "attachments": [
    { "id": 88, "filename": "entry-chart.png", "mime_type": "image/png", "url": "/api/external/v1/attachments/88" }
  ],

  "side": "LONG",
  "status": "WIN",
  "return": 42.5,
  "return_percentage": 3.1,
  "r_multiple": 1.8,
  "buy_quantity": 2,
  "sell_quantity": 2,
  "buy_fee": 1.24,
  "sell_fee": 1.24,
  "avg_buy_price": 21001.25,
  "avg_sell_price": 21022.5,
  "quantity": 2,
  "position": null,
  "entry_price": 21001.25,
  "exit_price": 21022.5,
  "entry_total": 42002.5,
  "exit_total": 42045.0,
  "hold_time_minutes": 37,
  "price_precision": 2,
  "first_action_at": "2026-05-12T14:00:00.000Z",
  "last_action_at": "2026-05-12T14:37:00.000Z"
}
```

Field notes:
- `journal` is `null` if the trade has no journal entry at all yet.
- `attachments[].url` is a relative path — fetch it against the same host as this API (see [GET /attachments/:id](#get-attachmentsid)).
- `position` is non-null only while `status` is `OPEN` (remaining open quantity). `quantity` is non-null only once closed (the round-trip size).
- For a still-`OPEN` trade: `return`, `return_percentage`, and `exit_total` are `null` (there's no exit yet to compute them from). `entry_total`, `avg_buy_price`/`avg_sell_price`, and `position` are **not** null — they describe the cost basis and size of what's currently held, and are exactly what you need alongside a live quote to compute unrealised PnL yourself (this API doesn't do that math for you).
- To compute unrealised PnL for an `OPEN` trade: `(quote_price - avg_buy_price) * position` for `LONG`, `(avg_sell_price - quote_price) * position` for `SHORT`. **For `type: "FUT"`, multiply the result by `tick_value / tick_size`** — a futures quote is a raw point price, not a dollar amount, so skipping this multiplier under/overstates the P&L by that ratio (e.g. MNQ's is 0.5/0.25 = 2x). `type: "STK"` needs no multiplier (equivalent to 1).
- `r_multiple` is `null` if the trade has no `stop_loss` set, or isn't closed yet.

---

## GET /trades/:id

Single trade, same shape as above.

`404` if the trade doesn't exist.

---

## PATCH /trades/:id/ai-analysis

Write-back: attach your analysis to a trade. Stored separately from `notes_html` (the user's own hand-written journal entry) — this can never overwrite what the user wrote.

### Request body

```json
{
  "analysis": "Free-text analysis, markdown or plain text.",
  "source": "hermes-gpt5"
}
```

`analysis` is required (non-empty string). `source` is optional — a free-text label for which tool/model produced it, shown in the app next to the analysis.

Upserts: if the trade has no journal row yet, one is created; if `ai_analysis` was already set, it's overwritten (there's no history — each call replaces the previous analysis for that trade).

### Response

```json
{ "success": true }
```

`404` if the trade doesn't exist. `400` if `analysis` is missing/empty.

---

## GET /daynotes

List day notes (journal entries per calendar day, independent of any specific trade).

### Query parameters

| Param | Type | Description |
|---|---|---|
| `account_id` | int | Restrict to one account. Omit for all accounts. |
| `from` / `to` | ISO date | Filters on the note's `date`. |

### Response

```json
{
  "total": 12,
  "day_notes": [
    {
      "id": 7,
      "account_id": 1,
      "account_name": "Main",
      "date": "2026-05-12",
      "mood": 3,
      "market_condition": 1,
      "market_volume": 2,
      "summary": "Choppy morning, cleaner trend after lunch.",
      "notes_html": "<p>...</p>",
      "created_at": "...",
      "updated_at": "...",
      "attachments": [ { "id": 90, "filename": "eod.png", "mime_type": "image/png", "url": "/api/external/v1/attachments/90" } ]
    }
  ]
}
```

---

## GET /attachments/:id

Raw binary for a trade or day-note attachment (screenshots, mostly — useful if your analysis tool does vision/chart reading). Returns the image directly with the correct `Content-Type`, not JSON.

`404` if the attachment doesn't exist.

```bash
curl http://localhost:3999/api/external/v1/attachments/88 -o entry-chart.png
```

---

## GET /symbols

Instrument settings — tick size/value, fees, margins, exchange, and per-timeframe fetch configuration.

```json
{
  "symbols": [
    {
      "id": 3,
      "symbol": "MNQ",
      "type": "FUT",
      "tick_size": 0.25,
      "tick_value": 0.5,
      "fee": 1.24,
      "exchange": "CME",
      "rollover_months": [3, 6, 9, 12],
      "initial_margin": 1760,
      "maintenance_margin": 1600,
      "timeframe_settings": {
        "1D": { "enabled": true },
        "1H": { "enabled": true }
      },
      "timezone": "America/Chicago"
    }
  ]
}
```

---

## GET /historical

Historic OHLCV price bars for a symbol — the same data the app's own charts use, including the IBKR/Yahoo merge (IBKR data preferred, extended with more-recent Yahoo data where IBKR hasn't caught up; see `modules/historical-data-service.js` for the exact provenance rules).

### Gaps get filled in the background, not before this response

This endpoint always responds immediately from whatever is already in the database — it never blocks the request to backfill first. If the returned bars have a gap (e.g. the enabled timeframe hasn't been fetched recently, or IBKR/Yahoo were briefly unreachable), a background refresh for that exact `symbol`/`timeframe`/`type` is queued automatically as a side effect of the request, the same priority-boosted fetch the app's own UI triggers when you open a chart. A gap-filling background sweep also now runs every 30 minutes for all configured symbols independently of API access. Either way: **the fix generally isn't visible on this same response — call `GET /historical` again a short while later (seconds to low tens of seconds, depending on source) and the gap should be filled.** Repeated calls within 60 seconds for the same symbol/timeframe won't queue duplicate fetches.

### Query parameters

| Param | Required | Description |
|---|---|---|
| `symbol` | yes | e.g. `MNQ`, `AAPL`. |
| `timeframe` | yes | One of `1M`, `5M`, `15M`, `1H`, `4H`, `1D`, `1W`. |
| `type` | no | `STK` or `FUT`, default `FUT`. |
| `contract_month` | no | e.g. `202506`. Omit for the continuous (rollover-adjusted) series — the right choice for most analysis. |
| `from` / `to` | no | ISO date/time bounds. |

### Response

```json
{
  "symbol": "MNQ",
  "type": "FUT",
  "timeframe": "1D",
  "contract_month": null,
  "bar_count": 750,
  "bars": [
    {
      "time": "2026-05-12T00:00:00.000Z",
      "open": 20980.25, "high": 21040.0, "low": 20955.5, "close": 21001.25,
      "volume": 184213,
      "source": "IBKR",
      "contractMonth": "202506",
      "isRollover": false
    }
  ]
}
```

`404` if no symbol settings exist for that `symbol`/`type` combination (add the symbol in the app first — Settings → Symbols).

---

## GET /quote/:symbol

Current price via Yahoo Finance (same source the app uses for live prices).

```bash
curl "http://localhost:3999/api/external/v1/quote/MNQ?type=FUT"
```

```json
{
  "symbol": "MNQ",
  "price": 21010.5,
  "price_source": "regularMarketPrice",
  "market_state": "REGULAR",
  "last_updated": "2026-05-12T14:35:02.000Z"
}
```

`type=FUT` (default) appends `=F` to the Yahoo lookup; pass `type=STK` for stocks.

### If Yahoo's live quote is unavailable

Yahoo's quote endpoint occasionally fails server-side (e.g. crumb/auth issues on Yahoo's end, or rate-limiting) — independent of anything wrong with this app. Rather than a bare error, this endpoint degrades to the most recent bar already stored for that symbol (any timeframe, whichever source last updated it — commonly the live TradingView feed for actively-traded symbols, which stays close to real-time regardless of Yahoo's status):

```json
{
  "symbol": "MNQ",
  "price": 29939.5,
  "price_source": "historical_bar_fallback (TradingView, 1M)",
  "market_state": "UNKNOWN",
  "last_updated": "2026-08-05T12:37:00.000Z",
  "live_quote_error": "Failed to extract crumb from Yahoo page"
}
```

`price_source` starting with `historical_bar_fallback` (rather than `regularMarketPrice`/`bid`/`ask`/etc.) means this — check it if you need to know whether the price came from Yahoo's live quote or our own stored data. `502` is only returned if the live quote fails **and** there's no stored data at all to fall back to.

---

## Example: pull last 30 days of closed trades with charts, for an LLM to review

```bash
# 1. List recently closed trades
curl "http://localhost:3999/api/external/v1/trades?status=WIN,LOSS,WASH&from=2026-04-12" | jq .

# 2. For each trade with attachments, fetch the chart image
curl "http://localhost:3999/api/external/v1/attachments/88" -o trade-4821-entry.png

# 3. Pull the underlying price series for context
curl "http://localhost:3999/api/external/v1/historical?symbol=MNQ&timeframe=15M&from=2026-05-12&to=2026-05-13" | jq .bars

# 4. Write the analysis back
curl -X PATCH "http://localhost:3999/api/external/v1/trades/4821/ai-analysis" \
  -H "Content-Type: application/json" \
  -d '{"analysis": "...", "source": "my-analysis-tool"}'
```
