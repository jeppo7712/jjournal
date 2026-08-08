# Live data from TradingView

If you trade through TradingView (backed by your own IBKR data subscription), you can feed live 1-minute bars into the journal as they close — no second IBKR connection needed, since TradingView keeps its own link and just pushes bars out to you. Once bars are flowing in, they show up automatically wherever the app already merges historical data (its own charts, and the [External API](../EXTERNAL_API.md)'s `GET /historical`) — there's no separate "live" endpoint to consume, TradingView-sourced bars just extend the existing series past wherever IBKR's own backfill has reached, with priority over Yahoo.

Implementation: `routes/tradingview-webhook.js`. Merge behavior: `getMergedHistoricalSeries` in `modules/historical-data-service.js`.

## Why this needs to be reachable from the internet

TradingView alerts are evaluated and dispatched from TradingView's own cloud servers — that's what lets an alert fire even when you're not watching the chart or don't have the app open. The webhook POST always originates from the public internet, regardless of where you run the TradingView app yourself. There's no way around exposing *something*, but it doesn't have to be much — see below.

## 1. The secret

A `tradingViewWebhookSecret` is already generated in your `config.json` (added when this feature was set up). Anyone who can reach the webhook URL *and* knows this secret can write bars into your journal, so treat it like a password — it's what stands in for the "no auth, trusted network" model the rest of the app uses, since this one endpoint can't rely on that.

## 2. Expose just this one path

Don't port-forward your whole app. Use a tunnel scoped to only the webhook route, so the rest of the app (including the unauthenticated External API) stays exactly as private as it already is.

**[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (free, no static IP or router config needed):**

```bash
# On the machine running the journal (or anywhere on the same LAN):
cloudflared tunnel login
cloudflared tunnel create jjournal-webhook
cloudflared tunnel route dns jjournal-webhook tv-webhook.yourdomain.com
```

Then a config pointing *only* at the webhook path:

```yaml
# ~/.cloudflared/config.yml
tunnel: jjournal-webhook
credentials-file: /path/to/jjournal-webhook.json

ingress:
  - hostname: tv-webhook.yourdomain.com
    path: /api/webhooks/tradingview-bar
    service: http://192.168.1.6:3999
  - service: http_status:404   # everything else on this tunnel: refused
```

```bash
cloudflared tunnel run jjournal-webhook
```

Your public webhook URL is now `https://tv-webhook.yourdomain.com/api/webhooks/tradingview-bar` — nothing else on your network is reachable through it.

(No domain on Cloudflare? A [Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) — `cloudflared tunnel --url http://192.168.1.6:3999` — gets you a temporary `*.trycloudflare.com` URL with no DNS setup, good for testing before committing to the config above.)

## 3. The TradingView alert

Use `docs/journal-live-feed.pine` — a small indicator that fires once per bar close and builds the entire webhook JSON body itself via Pine's `alert()` function. This avoids the alert dialog's `{{ticker}}`-style placeholders entirely (TradingView's own ticker, e.g. `MNQ1!`, won't match your journal's symbol naming, so those aren't usable directly anyway).

1. Open Pine Editor, paste in `journal-live-feed.pine`, add it to the chart you want to feed (1-minute, or whatever timeframe — this endpoint accepts any of `1M 5M 15M 1H 4H 1D 1W`).
2. Fill in its inputs: Journal Symbol (must exactly match Settings → Symbols, e.g. `MNQ`), Type, Journal Timeframe Code, and the Webhook Secret from `config.json`.
3. Create an alert on it: **Condition** = "Journal Live Feed". Because the script fires via Pine's `alert()` function rather than a plotted condition, the **Trigger** dropdown won't offer "Once Per Bar Close" here — it'll only show **"Any alert() function call"**, which is correct and expected. The once-per-bar-close timing is already handled inside the script itself (`alert(msg, alert.freq_once_per_bar_close)`), not by this dialog. Set **Webhook URL** to the tunnel URL from step 2, and leave the alert's own Message box as the default — the script supplies the actual body.

One alert per symbol+timeframe you want live-fed.

<details>
<summary>Doing it by hand instead (no indicator, plain alert condition + message template)</summary>

- **Trigger:** *Once Per Bar Close*
- **Webhook URL:** the tunnel URL from step 2.
- **Message** (exact JSON — type the symbol literally, not `{{ticker}}`):

```json
{
  "secret": "paste-your-tradingViewWebhookSecret-here",
  "symbol": "MNQ",
  "type": "FUT",
  "timeframe": "1M",
  "time": "{{time}}",
  "open": {{open}},
  "high": {{high}},
  "low": {{low}},
  "close": {{close}},
  "volume": {{volume}}
}
```

</details>

## 4. Verify it's working

Watch the server log (`GET /api/config/logs` or the Settings page's log viewer) for `[TradingView webhook]` lines after the next bar closes. A `401` means the secret in the alert message doesn't match `config.json`; a `404` means the symbol isn't set up in Settings yet.
