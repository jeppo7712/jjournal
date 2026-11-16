# Reaching the journal from the internet with Cloudflare Access

The journal has no login of its own. If you want to open it from outside your home network without a VPN, one way is a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) with a [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) application in front of it: Cloudflare asks for a login (e.g. your Google account) before any request reaches the journal.

Know the trade-off before you do this: Cloudflare ends the HTTPS connection at its own servers, so Cloudflare can technically see everything the journal shows you. If that's not acceptable, use a VPN instead.

## 1. Access application first, route second

Create the Access application **before** the tunnel route and DNS record, so there is never a moment where the hostname reaches the journal without a login.

In Cloudflare Zero Trust → Access → Applications → Add → Self-hosted:

- **Domain:** the hostname you'll use, e.g. `journal.example.com` — the whole hostname, no path.
- **Policy:** Allow, Include → *Emails* → your own address only. Never use "Login methods" or "Emails ending in @gmail.com" as the *include* rule: that lets in anyone with such an account.
- **Login methods:** only the one you use (e.g. Google), and turn on instant auth so you skip the chooser.
- **Cookie settings:** HttpOnly on, SameSite Lax, binding cookie on.
- **Session duration:** whatever you're comfortable with (a week is reasonable).

Don't add Bypass rules to this application.

Then add the public hostname to your tunnel, pointing at the journal (e.g. `http://jjournal:3999`), and let Cloudflare create the DNS record.

## 2. TradingView webhook: keep it on its own hostname

TradingView's servers can't log in through Access. Keep the webhook on a **separate** hostname whose tunnel route only matches the webhook paths (see [tradingview-webhook.md](tradingview-webhook.md)), rather than adding a Bypass rule to the journal's Access application.

## 3. Turn on the journal's own check

Access is then the only lock: a mistake in the Cloudflare dashboard later (a deleted Access application, a new tunnel route without one) would quietly leave the journal open. The journal can check, for every request that came through Cloudflare, that Access really let it through. Add this to `config.json` and restart:

```json
"cloudflareAccess": {
  "teamDomain": "yourteam.cloudflareaccess.com",
  "aud": "<Application Audience (AUD) tag>",
  "allowedEmails": ["you@example.com"]
}
```

- `teamDomain`: your Zero Trust team domain (Zero Trust → Settings → Custom Pages, or the domain in the login page's URL).
- `aud`: the Access application's *Application Audience (AUD) Tag* (application → Overview / Basic information). It can be an array if several Access applications point at the journal.
- `allowedEmails` (optional): only these logins are accepted, on top of the Access policy.

With this set, a request that came through Cloudflare (it carries Cloudflare's `Cf-Ray` / `Cf-Connecting-Ip` headers) must carry a valid `Cf-Access-Jwt-Assertion` token: signed by your team's Access keys, for this `aud`, from your team domain, not expired. Otherwise the journal answers `403` and logs `[Cloudflare Access] Refused …` with the reason. WebSocket connections get the same check.

Not affected:

- Requests that don't come through Cloudflare (your LAN, your VPN) — they work exactly as before.
- `/api/webhooks/*` — TradingView can't log in through Access; those routes check their own shared secret.

Implementation: `modules/cloudflare-access.js`.
