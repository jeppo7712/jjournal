// A POST that books something (a deposit, a transfer, a dividend ...) is
// answered once per save key. The form sends a key of its own in the
// X-Save-Key header. When the booking went in but the answer was lost on the
// way back (a phone's connection dropping), pressing Save again booked it a
// second time. Now a repeat with the same values gets the first answer
// back, and one arriving while the first is still running waits for it. A
// repeat with other values is refused rather than booked or dropped: the
// first one is in, the list shows it. A refused or failed save frees its
// key, so a real retry goes through. Without the header nothing changes.
//
// Kept in memory for a day, long enough for any retry; a server restart
// forgets the keys.
const TTL_MS = 24 * 60 * 60 * 1000;

function saveOnce() {
    const entries = new Map(); // key -> { at, body, done: Promise<{ status, json } | null> }

    return async (req, res, next) => {
        const raw = req.get('X-Save-Key');
        if (!raw || raw.length > 100) return next();
        const key = `${req.accountId}:${req.baseUrl}${req.path}:${raw}`;
        const body = JSON.stringify(req.body ?? null);

        const earlier = entries.get(key);
        if (earlier) {
            const first = await earlier.done;
            if (first) {
                if (earlier.body !== body) {
                    return res.status(409).json({ error: 'This form was already saved once, with other values (the answer was lost on the way). Check the list before saving again.' });
                }
                return res.status(first.status).json(first.json);
            }
        }

        const now = Date.now();
        for (const [k, entry] of entries) if (now - entry.at > TTL_MS) entries.delete(k);
        let finish;
        const done = new Promise(resolve => { finish = resolve; });
        const entry = { at: now, body, done };
        entries.set(key, entry);
        let settled = false;
        const settle = (result) => {
            if (settled) return;
            settled = true;
            finish(result);
            if (!result && entries.get(key) === entry) entries.delete(key);
        };

        const json = res.json.bind(res);
        res.json = (payload) => {
            settle(res.statusCode >= 200 && res.statusCode < 300 ? { status: res.statusCode, json: payload } : null);
            return json(payload);
        };
        // Answered some other way, or not at all: not a save to replay.
        res.on('close', () => settle(null));
        next();
    };
}

module.exports = { saveOnce };
