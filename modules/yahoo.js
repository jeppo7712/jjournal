const YahooFinance = require('yahoo-finance2').default;
// Create a client instance when library requires it (v3+).
const yfClient = (typeof YahooFinance === 'function') ? new YahooFinance() : YahooFinance;
const { Agent } = require('undici');

// Yahoo's cert chain has been problematic in this environment, so TLS
// validation is relaxed for Yahoo requests specifically via a dedicated
// undici dispatcher passed per-request (see ensureGlobalFetchWrapped below).
// IMPORTANT: this must stay scoped to Yahoo — do NOT set
// process.env.NODE_TLS_REJECT_UNAUTHORIZED, which would disable certificate
// validation for every outgoing HTTPS request in the whole process
// (IBKR Flex, etc.), not just Yahoo.
const insecureYahooAgent = new Agent({ connect: { rejectUnauthorized: false } });

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 365; // ~1 year
const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
};

let crumbCache = {
    crumb: null,
    cookie: null,
    fetchedAt: 0
};

// Wrap global.fetch to inject headers/cookies for Yahoo endpoints.
function ensureGlobalFetchWrapped() {
    if (global.__YAHOO_FETCH_WRAPPED__) return;
    const originalFetch = global.fetch;
    if (!originalFetch) return; // Node <20 might not have global.fetch

    global.fetch = async (url, options = {}) => {
        try {
            const isYahoo = typeof url === 'string' && (url.includes('query1.finance.yahoo.com') || url.includes('finance.yahoo.com'));
            if (isYahoo) {
                options = Object.assign({}, options);
                options.headers = Object.assign({}, browserHeaders, options.headers || {});
                if (crumbCache && crumbCache.cookie) options.headers.cookie = crumbCache.cookie;
                // Ensure redirects are followed
                options.redirect = options.redirect || 'follow';
                // Relax TLS validation for this Yahoo request only (see comment above).
                options.dispatcher = insecureYahooAgent;
            }
            return await originalFetch(url, options);
        } catch (err) {
            return await originalFetch(url, options);
        }
    };
    global.__YAHOO_FETCH_WRAPPED__ = true;
}

// Initialize wrapper immediately
ensureGlobalFetchWrapped();

function isCacheValid() {
    return crumbCache.crumb && (Date.now() - crumbCache.fetchedAt) < CACHE_TTL_MS;
}

async function fetchPage(url, options = {}) {
    // Use global fetch available in Node >=20 (engines specifies >=20)
    const fetchOptions = Object.assign({ headers: browserHeaders, redirect: 'follow' }, options);
    return await fetch(url, fetchOptions);
}

function decodeCrumb(raw) {
    try {
        return JSON.parse('"' + raw.replace(/\\u/g, '\\u') + '"');
    } catch (e) {
        return raw;
    }
}

async function obtainCrumbAndCookie(symbol) {
    if (isCacheValid()) return crumbCache;

    const url = `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;
    const res = await fetchPage(url, { method: 'GET' });

    if (res.status === 401 || res.status === 403) {
        const err = new Error(`Yahoo returned ${res.status} for crumb request`);
        err.status = res.status;
        throw err;
    }

    const text = await res.text();

    // Collect cookies
    const setCookie = res.headers.get('set-cookie') || res.headers.get('cookie') || '';

    // Try multiple strategies to extract crumb from page HTML/JS
    let crumbRaw = null;

    // Strategy 1: direct CrumbStore JSON
    const directMatch = text.match(/"CrumbStore"\s*:\s*\{\s*"crumb"\s*:\s*"([^"\\]+(?:\\.[^"\\]*)*)"\s*\}/);
    if (directMatch) crumbRaw = directMatch[1];

    // Strategy 2: escaped variant
    if (!crumbRaw) {
        const escMatch = text.match(/CrumbStore\\"\\:\{\\"crumb\\"\\:\\"([^\\"]+)\\"\\}/);
        if (escMatch) crumbRaw = escMatch[1];
    }

    // Strategy 3: look for root.App.main = {...} and parse JSON, then find CrumbStore inside
    if (!crumbRaw) {
        const rootAppMatch = text.match(/root\.App\.main\s*=\s*({[\s\S]*?})\s*;/);
        if (rootAppMatch) {
            try {
                const parsed = JSON.parse(rootAppMatch[1]);
                const findCrumb = (obj) => {
                    if (!obj || typeof obj !== 'object') return null;
                    if (Object.prototype.hasOwnProperty.call(obj, 'CrumbStore') && obj.CrumbStore && obj.CrumbStore.crumb) return obj.CrumbStore.crumb;
                    for (const key of Object.keys(obj)) {
                        try {
                            const val = obj[key];
                            const found = findCrumb(val);
                            if (found) return found;
                        } catch (e) {
                            continue;
                        }
                    }
                    return null;
                };
                const maybe = findCrumb(parsed);
                if (maybe) crumbRaw = maybe;
            } catch (e) {
                // ignore JSON parse errors
            }
        }
    }

    // Strategy 4: fallback regex for any "crumb":"..." pattern nearby the word Crumb
    if (!crumbRaw) {
        const loose = text.match(/CrumbStore[\s\S]{0,200}?"crumb"\s*:\s*"([^"\\]+)"/);
        if (loose) crumbRaw = loose[1];
    }

    if (!crumbRaw) {
        const err = new Error('Failed to extract crumb from Yahoo page');
        err.status = res.status;
        throw err;
    }

    const crumb = decodeCrumb(crumbRaw);
    crumbCache = { crumb, cookie: setCookie, fetchedAt: Date.now() };
    return crumbCache;
}

function invalidateCache() {
    crumbCache = { crumb: null, cookie: null, fetchedAt: 0 };
}

async function safeFetchJson(url, fetchOptions = {}) {
    const res = await fetch(url, fetchOptions);
    if (res.status === 401 || res.status === 403) {
        invalidateCache();
        const err = new Error(`Yahoo returned ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return await res.json();
}

async function quote(symbol) {
    // Prefer the official client API first; it's less noisy and may succeed without manual crumb extraction.
    try {
        const result = await yfClient.quote(symbol);
        if (result) return result;
    } catch (clientErr) {
        // fall through to manual crumb-based fetch
    }

    // Manual fetch fallback
    const { cookie } = await obtainCrumbAndCookie(symbol);
    const headers = Object.assign({}, browserHeaders);
    if (cookie) headers['cookie'] = cookie;
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const fetchOptions = { method: 'GET', headers };
    try {
        const json = await safeFetchJson(url, fetchOptions);
        const result = json?.quoteResponse?.result?.[0] || null;
        if (!result) throw new Error('No quote returned from Yahoo');
        return result;
    } catch (err) {
        if (err.status === 401 || err.status === 403) {
            invalidateCache();
            const { cookie: cookie2 } = await obtainCrumbAndCookie(symbol);
            const headers2 = Object.assign({}, browserHeaders);
            if (cookie2) headers2['cookie'] = cookie2;
            const json2 = await safeFetchJson(url, { method: 'GET', headers: headers2 });
            const result2 = json2?.quoteResponse?.result?.[0] || null;
            if (!result2) throw new Error('No quote returned from Yahoo after retry');
            return result2;
        }
        throw err;
    }
}

async function chart(symbol, queryOptions = {}) {
    // Ensure crumb/cookie is populated so global fetch wrapper can attach cookie header.
    try {
        await obtainCrumbAndCookie(symbol);
    } catch (err) {
        if (err && (err.status === 401 || err.status === 403)) {
            invalidateCache();
        }
        // Continue; global fetch wrapper will still add browser headers.
    }

    return await yfClient.chart(symbol, queryOptions);
}

module.exports = {
    quote,
    chart,
    invalidateCache,
    _internal: { yfClient }
};
