// ==UserScript==
// @name         Torn Auction Insights
// @namespace    https://github.com/josh088/torn-auction-insights-userscript
// @version      1.0.1
// @description  Annotates Torn's auction house with realised-price valuations, so you can size a maximum bid without leaving the page.
// @author       josh088
// @match        https://www.torn.com/amarket.php*
// @connect      api.torninsights.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/josh088/torn-auction-insights-userscript/main/torn-auction-insights.user.js
// @updateURL    https://raw.githubusercontent.com/josh088/torn-auction-insights-userscript/main/torn-auction-insights.user.js
// ==/UserScript==

/*
 * This script reads the page and displays information. It never bids, never clicks, and
 * never sends a request to Torn — everything it needs is already in the response Torn's own
 * auction page fetches to draw the list.
 *
 * How it works
 * ------------
 * `amarket.php` populates the listing table from a JSON response that carries, per row:
 * `itemID` (the Torn item id), `armouryID` (the physical item's uid), `glowClass` (rarity)
 * and `item_image_icons` (an HTML fragment whose title attribute holds the bonus name and
 * value). That is every key the valuation API needs, so one batch call values a whole page.
 *
 * We hook XMLHttpRequest and fetch at document-start to see that response. Hooking rather
 * than scraping is what keeps the bonus available without expanding each row's details panel.
 */

(function () {
    'use strict';

    const API_BASE = 'https://api.torninsights.com';
    const MAX_BATCH = 25;

    /*
     * Where a row lives in the DOM.
     *
     * This is the fragile part of the script and the only part that depends on Torn's markup
     * rather than its data. Torn puts each row's `arialabel` from the JSON onto the element
     * as `aria-label`, which gives an exact match; the rest are progressively weaker
     * fallbacks. If Torn changes the page, fix it here — everything else keys off the JSON,
     * which changes far less often.
     *
     * When no row can be matched the script does not fail: the floating panel still lists
     * every valuation, so the page stays useful while a selector is stale.
     */
    const ROW_SELECTORS = ['ul.item-list > li', 'ul[class*="auction"] > li', 'li[class*="item"]'];

    const state = { seen: new Set() };

    // ---------------------------------------------------------------- token

    function getToken() {
        return GM_getValue('api_token', '');
    }

    function promptForToken() {
        const current = getToken();
        const next = window.prompt(
            'Torn Insights API token.\n\nGenerate one with `php artisan user:generate-api-token` on the API host.',
            current
        );

        if (next !== null) {
            GM_setValue('api_token', next.trim());
            window.location.reload();
        }
    }

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Set API token', promptForToken);
    }

    // ---------------------------------------------------------------- parsing

    /**
     * Pull bonuses out of the icon fragment Torn ships with each row.
     *
     * The title reads `<b>Revitalize</b><br/>11% chance of restoring energy...`. Two traps:
     * the icon's CSS class is NOT the bonus name (`Double Tap` renders as
     * `bonus-attachment-fury`), and the value is the FIRST number before a `%` — Motivation
     * reads "15% chance to Motivate self increasing all stats by 10% (x5)" and means 15.
     */
    function parseBonuses(html) {
        if (!html) return [];

        const bonuses = [];
        const doc = new DOMParser().parseFromString(html, 'text/html');

        doc.querySelectorAll('.bonus-attachment-icons').forEach((el) => {
            const title = el.getAttribute('title') || '';
            const parsed = new DOMParser().parseFromString(title, 'text/html');
            const name = parsed.querySelector('b')?.textContent?.trim();
            if (!name) return;

            // Strip the name before looking for the value, so a digit inside a bonus name
            // could never be read as the roll.
            const rest = parsed.body.textContent.replace(name, '');
            const match = rest.match(/(\d+)\s*%/);
            if (!match) return;

            bonuses.push({ name, value: parseInt(match[1], 10) });
        });

        return bonuses;
    }

    /** `glow-yellow` -> `yellow`. Anything else is not a ranked-war item we can price. */
    function parseRarity(glowClass) {
        const match = /glow-(yellow|orange|red)/.exec(glowClass || '');
        return match ? match[1] : null;
    }

    function parseMoney(text) {
        const digits = String(text || '').replace(/[^0-9]/g, '');
        return digits ? parseInt(digits, 10) : null;
    }

    /**
     * One JSON row into the request shape, or null if it is not a priceable item.
     *
     * Rarity comes from `glowClass` and never from the bonus count: orange rows can carry a
     * single bonus, and our own data splits orange 15,891 single-bonus to 3,015 double.
     */
    function toListing(row) {
        const rarity = parseRarity(row.glowClass);
        const bonuses = parseBonuses(row.item_image_icons);

        if (!rarity || !bonuses.length || !row.itemID) return null;

        return {
            torn_item_id: Number(row.itemID),
            rarity,
            bonuses,
            listing_uid: row.armouryID ? Number(row.armouryID) : null,
            current_bid: parseMoney(row.topbid),
            _key: String(row.ID),
            _aria: row.arialabel || '',
            _name: row.itemName || '',
        };
    }

    // ---------------------------------------------------------------- api

    /**
     * Value every listing on the page, in chunks the endpoint will accept.
     *
     * Chunked rather than truncated at MAX_BATCH. A Torn page shows ten, so this should never
     * fire twice — but dropping the overflow silently would read as "that is all there is",
     * which is the one thing a tool like this must never do.
     */
    function valuate(listings) {
        const token = getToken();

        if (!token) {
            renderPanel([], 'No API token set. Use the Tampermonkey menu -> "Set API token".');
            return;
        }

        const chunks = [];
        for (let i = 0; i < listings.length; i += MAX_BATCH) {
            chunks.push(listings.slice(i, i + MAX_BATCH));
        }

        Promise.all(chunks.map((chunk) => requestChunk(chunk, token)))
            .then((results) => {
                const paired = results.flat();
                paired.forEach(({ valuation, listing }) => annotateRow(listing, valuation));
                renderPanel(paired, null);
            })
            .catch((message) => renderPanel([], message));
    }

    function requestChunk(listings, token) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `${API_BASE}/auction-valuations`,
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                data: JSON.stringify({ listings: listings.map(stripLocalKeys) }),
                onload(response) {
                    if (response.status === 401) {
                        return reject('API token rejected. Use the menu to set a new one.');
                    }

                    if (response.status === 429) {
                        return reject('Rate limited by the API. It will recover in a minute.');
                    }

                    if (response.status !== 200) {
                        return reject(`API returned ${response.status}.`);
                    }

                    let body;
                    try {
                        body = JSON.parse(response.responseText);
                    } catch (error) {
                        return reject('API returned something that was not JSON.');
                    }

                    // Order is guaranteed by the endpoint, which is how results zip back onto the
                    // rows: a page can hold two listings of the same item and roll that differ
                    // only in uid, so there is no key to match on.
                    resolve(body.data.map((valuation, index) => ({
                        valuation,
                        listing: listings[index],
                    })));
                },
                onerror() {
                    reject('Could not reach the API.');
                },
            });
        });
    }

    function stripLocalKeys(listing) {
        const { _key, _aria, _name, ...rest } = listing;
        return rest;
    }

    // ---------------------------------------------------------------- rendering

    function money(value) {
        if (value === null || value === undefined) return '—';
        return Math.abs(value) >= 1e9
            ? `$${(value / 1e9).toFixed(2)}bn`
            : `$${(value / 1e6).toFixed(1)}m`;
    }

    /**
     * How a row reads at a glance.
     *
     * Driven by the percentile of the live bid against realised prices, but gated on
     * `basis.sufficient` — a percentile drawn from a refused basis does not exist, and one
     * drawn from nine pooled neighbours deserves to look different from one drawn from 363
     * sales of the exact roll. That is what `tier` is shown for.
     */
    function verdict(valuation) {
        if (!valuation.basis.sufficient) return { label: 'no data', tone: '#8b8b8b' };

        const percentile = valuation.current_bid_percentile;
        if (percentile === null || percentile === undefined) return { label: 'priced', tone: '#7aa7d9' };
        if (percentile >= 85) return { label: 'rich', tone: '#d96b6b' };
        if (percentile <= 25) return { label: 'cheap', tone: '#6bd98a' };
        return { label: 'fair', tone: '#d9c46b' };
    }

    function findRowElement(listing) {
        if (listing._aria) {
            const exact = document.querySelector(`[aria-label="${CSS.escape(listing._aria)}"]`);
            if (exact) return exact;
        }

        for (const selector of ROW_SELECTORS) {
            const candidates = Array.from(document.querySelectorAll(selector));
            const match = candidates.find((el) => el.querySelector(`a[href*="iteminfo.php?ID=${listing.torn_item_id}"]`));
            if (match) return match;
        }

        return null;
    }

    function annotateRow(listing, valuation) {
        const row = findRowElement(listing);
        if (!row || row.querySelector('.tai-badge')) return;

        const { label, tone } = verdict(valuation);
        const badge = document.createElement('div');
        badge.className = 'tai-badge';
        badge.style.cssText = `
            display:flex; gap:8px; align-items:center; flex-wrap:wrap;
            padding:4px 8px; margin:2px 0 6px; border-left:3px solid ${tone};
            background:rgba(0,0,0,.28); color:#ddd; font-size:11px; cursor:pointer;
        `;

        const median = valuation.distribution ? money(valuation.distribution.median) : '—';
        const percentile = valuation.current_bid_percentile;

        badge.innerHTML = `
            <b style="color:${tone}">${label.toUpperCase()}</b>
            <span>median <b>${median}</b></span>
            <span>max <b>${money(valuation.recommended_max)}</b></span>
            <span>${percentile === null || percentile === undefined ? '' : `bid at <b>${Math.round(percentile)}%</b>`}</span>
            <span style="opacity:.6">n=${valuation.basis.sales} · ${valuation.basis.tier}</span>
            ${valuation.uid_history.length ? '<span style="color:#d9a76b">◆ sold before</span>' : ''}
        `;

        badge.addEventListener('click', () => showDetail(listing, valuation));
        row.prepend(badge);
    }

    function showDetail(listing, v) {
        document.querySelector('.tai-detail')?.remove();

        const panel = document.createElement('div');
        panel.className = 'tai-detail';
        panel.style.cssText = `
            position:fixed; right:16px; bottom:16px; z-index:99999; width:420px;
            max-height:70vh; overflow:auto; padding:14px 16px; border-radius:6px;
            background:#1c1c1c; color:#ddd; border:1px solid #3a3a3a;
            font:12px/1.5 system-ui, sans-serif; box-shadow:0 6px 24px rgba(0,0,0,.5);
        `;

        const curve = v.win_curve
            .map((p) => `<span style="display:inline-block;width:64px">${money(p.max)}<br><b>${Math.round(p.win_pct)}%</b></span>`)
            .join('');

        const history = v.uid_history
            .map((s) => `<div>${s.sold_at.slice(0, 10)} — <b>${money(s.price)}</b> (${s.bids ?? '?'} bids) to ${s.buyer_name ?? '?'}</div>`)
            .join('');

        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:start">
              <div><b style="font-size:14px">${listing._name}</b><br>
                   <span style="opacity:.7">${v.roll} · ${v.rarity}</span></div>
              <span class="tai-close" style="cursor:pointer;opacity:.6;font-size:16px">×</span>
            </div>

            <div style="margin:10px 0;padding:8px;background:#242424;border-radius:4px">
              <b>${v.basis.tier}</b> · ${v.basis.sales} sales / ${v.basis.window_days}d<br>
              <span style="opacity:.75">${v.basis.note}</span>
            </div>

            ${v.distribution ? `
              <div><b>Realised prices</b><br>
                min ${money(v.distribution.min)} · p25 ${money(v.distribution.p25)} ·
                <b>median ${money(v.distribution.median)}</b> · p75 ${money(v.distribution.p75)} ·
                max ${money(v.distribution.max)}</div>

              <div style="margin-top:10px"><b>Win probability</b>
                <span style="opacity:.6">— your maximum vs the runner-up's</span>
                <div style="margin-top:4px;white-space:nowrap;overflow-x:auto">${curve}</div>
                ${v.flattens_above ? `<div style="opacity:.7;margin-top:4px">Flattens above ${money(v.flattens_above)} — further bids buy under 3 points a step.</div>` : ''}
              </div>

              <div style="margin-top:10px;padding:8px;background:#2a2a20;border-radius:4px">
                <b style="font-size:13px">Maximum ${money(v.recommended_max)}</b>
                <span style="opacity:.7">(${v.target_win}% win rate)</span><br>
                <span style="opacity:.7">Bid it once, as your true maximum, just above a round number — never on one.</span>
              </div>
            ` : '<div style="opacity:.7">No comparable sales. Nothing to size a bid from.</div>'}

            ${v.exit ? `
              <div style="margin-top:10px"><b>Item market — the exit</b><br>
                ${v.exit.ask_depth} open · cheapest ${money(v.exit.cheapest)} → ${money(v.exit.cheapest_net)} net of the 5% fee<br>
                ${v.exit.ask_depth < 3 ? '<span style="color:#d9a76b">Under three asks: one optimist sets this price.</span><br>' : ''}
                <span style="opacity:.7">clears ${v.exit.clears_kept}/${v.exit.clears_total} — an inference that a listing sold, not an observed sale.</span>
              </div>` : ''}

            ${history ? `<div style="margin-top:10px"><b>This exact item has sold before</b>${history}
                <div style="opacity:.7">Of items sold twice, the second sale is lower 58% of the time, median −2.1%.</div></div>` : ''}

            ${v.bunker_floor ? `<div style="margin-top:10px;opacity:.75">Bunker floor ${money(v.bunker_floor)} (trade-in at $5.7m/BB).</div>` : ''}
        `;

        panel.querySelector('.tai-close').addEventListener('click', () => panel.remove());
        document.body.appendChild(panel);
    }

    function renderPanel(paired, error) {
        document.querySelector('.tai-summary')?.remove();

        const panel = document.createElement('div');
        panel.className = 'tai-summary';
        panel.style.cssText = `
            position:fixed; right:16px; top:80px; z-index:99998; width:300px;
            max-height:60vh; overflow:auto; padding:10px 12px; border-radius:6px;
            background:#1c1c1c; color:#ddd; border:1px solid #3a3a3a;
            font:11px/1.5 system-ui, sans-serif; box-shadow:0 4px 16px rgba(0,0,0,.4);
        `;

        if (error) {
            panel.innerHTML = `<b>Auction Insights</b><div style="margin-top:6px;color:#d96b6b">${error}</div>`;
            document.body.appendChild(panel);
            return;
        }

        const priced = paired.filter((p) => p.valuation.basis.sufficient).length;

        // The row annotations are the primary surface; this panel exists so a stale DOM
        // selector degrades into "less convenient" rather than "shows nothing".
        panel.innerHTML =
            `<div style="display:flex;justify-content:space-between"><b>Auction Insights</b>
               <span class="tai-close" style="cursor:pointer;opacity:.6">×</span></div>
             <div style="opacity:.7;margin-bottom:6px">${priced} of ${paired.length} priced</div>` +
            paired
                .map(({ valuation, listing }, index) => {
                    const { label, tone } = verdict(valuation);
                    const percentile = valuation.current_bid_percentile;
                    return `<div class="tai-line" data-index="${index}"
                                 style="cursor:pointer;padding:3px 0;border-top:1px solid #2c2c2c">
                        <b style="color:${tone}">${label}</b> ${listing._name}
                        <span style="opacity:.6">${valuation.roll}</span><br>
                        <span style="opacity:.75">median ${valuation.distribution ? money(valuation.distribution.median) : '—'}${
                        percentile === null || percentile === undefined ? '' : ` · bid at ${Math.round(percentile)}%`
                    }</span></div>`;
                })
                .join('');

        panel.querySelector('.tai-close').addEventListener('click', () => panel.remove());
        panel.querySelectorAll('.tai-line').forEach((line) => {
            line.addEventListener('click', () => {
                const { valuation, listing } = paired[Number(line.dataset.index)];
                showDetail(listing, valuation);
            });
        });

        document.body.appendChild(panel);
    }

    // ---------------------------------------------------------------- interception

    /**
     * Is this the auction list response?
     *
     * Identified by shape rather than by URL, because the page fetches several things from
     * the same endpoint and Torn changes query strings more readily than payloads.
     */
    function isAuctionList(body) {
        return body && body.success === true && Array.isArray(body.list) &&
            body.list.length > 0 && 'armouryID' in body.list[0];
    }

    function handlePayload(text) {
        let body;
        try {
            body = JSON.parse(text);
        } catch (error) {
            return;
        }

        if (!isAuctionList(body)) return;

        // The page refetches on tab switches and paging; a signature keeps one page from
        // being valued repeatedly while still valuing the next one.
        const signature = body.list.map((r) => r.ID).join(',');
        if (state.seen.has(signature)) return;
        state.seen.add(signature);

        const listings = body.list.map(toListing).filter(Boolean);
        if (!listings.length) return;

        // Rows render after the response resolves, so give the page a tick to draw them.
        setTimeout(() => valuate(listings), 400);
    }

    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._taiUrl = url;
        return nativeOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', () => {
            // Never let a failure in here break the page's own handler.
            try {
                if (this.responseType === '' || this.responseType === 'text') {
                    handlePayload(this.responseText);
                }
            } catch (error) {
                console.debug('[auction-insights]', error);
            }
        });

        return nativeSend.apply(this, args);
    };

    const nativeFetch = window.fetch;

    window.fetch = function (...args) {
        return nativeFetch.apply(this, args).then((response) => {
            try {
                response.clone().text().then(handlePayload).catch(() => {});
            } catch (error) {
                console.debug('[auction-insights]', error);
            }

            return response;
        });
    };
})();
