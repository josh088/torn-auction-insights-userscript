# Torn Auction Insights

A Tampermonkey userscript that annotates Torn's auction house with realised-price valuations,
so you can size a maximum bid without leaving the page.

![tier](https://img.shields.io/badge/requests%20to%20Torn-zero-brightgreen)

Each listing gets a badge — `cheap` / `fair` / `rich` / `thin` / `no data` — with the median realised
price, a recommended maximum, and where the live bid sits in that history. Click it for the
win-probability curve, the monthly trend, the item-market exit and any prior sale of that exact
physical item.

## It takes no action on your behalf

It reads the page and displays information. It never bids, never clicks, and never places or
cancels anything.

**It also sends nothing to Torn.** `amarket.php` already fetches a JSON payload to draw the
listing table, and that payload carries everything needed: `itemID`, `armouryID` (the physical
item's uid), `glowClass` (rarity) and the bonus name and value. The script reads that response
as it goes past and makes one call to its own API — so it adds zero requests to Torn, and
expanding a row's details panel is never necessary.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [`torn-auction-insights.user.js`](torn-auction-insights.user.js) and click **Raw**.
   Tampermonkey will offer to install it, and will auto-update from the same URL.
3. Generate an API token on the API host:
   ```
   php artisan user:generate-api-token
   ```
4. Open Torn's auction house, then Tampermonkey's menu → **Set API token**, and paste it.

The token is stored in Tampermonkey's own storage, which page scripts cannot read. Requests go
out through `GM_xmlhttpRequest`, so nothing on `torn.com` can see the token or the responses.

The floating panel lists every listing on the page. **Click its header to collapse it** — the
choice is remembered, so it stays as you left it. The `×` dismisses it for the current page
only, and is deliberately not remembered: a panel that never came back would look like the
script had broken.

## Reading the badge

```
CHEAP  median $26.0m  max $28.0m  bid at 0%   n=11 · exact_roll
```

| Field | Means |
|---|---|
| `median` | Middle realised price. Median, not mean — these distributions are heavily right-skewed |
| `max` | The maximum that would have won 75% of past auctions for this roll |
| `bid at` | Where the live bid sits in realised history, as a percentile |
| `n` | How many sales are behind it |
| `exact_roll` | **What answered** — read this one |
| `◆ sold before` | This exact physical item has sold at auction before |

### `basis` is the field to read first

Only 684 of 9,899 single-bonus rolls reach eight sales in 90 days, so most listings are priced
from something wider than the roll you are looking at. The API always says how far it reached:

| Tier | Means |
|---|---|
| `exact_roll` | Sales of this exact item, rarity and roll |
| `bonus_family_flat` | Every value of this bonus pooled, because price does not track the value here |
| `bonus_neighbours` | Only nearby values, because price *does* track the value |
| `insufficient` | Nothing comparable enough. **There is no price, and that is the answer** |

A refused basis still shows any **recorded sales of the exact roll** in the detail panel — the
badge reads `thin` rather than `no data` when it has some. MP 40 `Revitalize:14` has two sales,
$3.46bn and $3.00bn; that cannot support a percentile, but against a $3.5bn live bid it is the
whole answer. Read those rows as observations, never as a price — two sales have no middle
worth naming.

That last one is deliberate. Pooling a whole family where the roll matters would price a top
roll as a common one, and an invented number is worse than a blank because it renders
identically to a real one.

## The maximum is not what you pay

The auction house is a **second-price** venue: the winner pays the runner-up's maximum plus $1.
Two things follow, and the script is built around both.

**Sniping cannot work.** There is nothing to snipe — a late bid does not beat a higher standing
maximum.

**Bid your true maximum, once, just above a round number.** 55% of realised prices end in `001`
and half land on a recurring round-number anchor, so a bid *on* a round number loses to one a
dollar above it.

## When something looks wrong

The script degrades rather than disappearing. If it cannot find a row in the page it still
shows every valuation in the floating panel, so a stale selector costs you convenience, not the
feature.

| Symptom | Cause |
|---|---|
| "No API token set" | Tampermonkey menu → Set API token |
| "API token rejected" | Token revoked or mistyped; generate a new one |
| "Rate limited by the API" | 60 requests/minute; it clears within a minute |
| Panel appears, badges do not | Torn changed the listing markup — fix `ROW_SELECTORS` in the script |
| Nothing at all | Torn changed the list payload — check `isAuctionList()` against the live response |

## What it does not do

**It does not send the auction book anywhere.** It would be easy to post the listings it sees
back to the API and rebuild a picture of the live market, and that is deliberately not done: a
sample of "pages you happened to open" cannot prove a listing does not exist, which is the only
question such a record would be asked. A previous attempt at this sampled 33–38% of closes and
was retired for exactly that reason.

## Compatibility

Requires the `/auction-valuations` endpoint on
[torn-data-services-api](https://github.com/josh088/torn-data-services-api). Every response
carries a `schema_version`; this script targets **version 1**.

## Developing

```
npx eslint torn-auction-insights.user.js
```

`no-undef` is the rule that matters. `node --check` validates syntax and will happily pass a
reference to a variable that is not in scope — which shipped once, as a `ReferenceError` that
only appeared in the browser.

Bump `@version` in the header on every change, or Tampermonkey will not offer the update.

## Licence

MIT
