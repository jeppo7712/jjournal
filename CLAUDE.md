# Working in this repository

This repository is **public** on GitHub. Nothing from the owner's own trading or setup may end up in it — not in code, comments, tests, docs, screenshots, commit messages or commit metadata:

- no real account names or IDs, amounts, balances, prices, fills, dates of real activity, or symbols the owner trades or holds;
- no host names, IPs, paths, domains, emails, tokens or config values from the owner's machines;
- no links to Claude sessions, and no session trailers in commit messages.

When a bug is found from real data, describe and test it with **invented** values (made-up tickers such as `ABC` or `ETFA.DE`, account IDs such as `U1000001`, round made-up amounts and dates). Never copy a real statement row, API answer or log line into a test or doc, even with the account ID changed. Screenshots come from generated demo data only.

A pre-push hook (`.git/hooks/pre-push`, scanner in `.git/privacy/`, both outside version control) refuses a push that contains private data. If it refuses: fix the commits. Only add a string to `.git/privacy/allow.txt` when it is certainly not private (an invented value or public market data). Never push with `--no-verify`.

Commit as `jeppo7712 <20791692+jeppo7712@users.noreply.github.com>` (set in this repository's git config).
