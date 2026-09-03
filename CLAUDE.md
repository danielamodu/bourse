# Bourse

Buy Coinbase tokenized US stocks with Nigerian naira, on Base.

## Environment constraint

**Shell execution is unavailable in this setup.** Every command fails with exit 1 and no
output. This is a harness limitation, not something in the repo — do not probe it, do not
retry it, and do not write diagnostic probe files.

Write the code, then end your report with the exact commands the user should run
(`npm install`, `npm run typecheck`, `npm test`, `npm run build`) and state plainly that
nothing has been executed. Compensate by re-reading your own files for import, export, type
and config errors before reporting done, since a build will not catch them for you.

## Verified on-chain facts — do not re-derive or "correct" these

- **13 tokens issued.** `AAPL`, `AMZN`, `COIN`, `CRCL`, `GOOGL`, `INTC`, `META`, `MSFT`,
  `MSTR`, `NVDA`, `SNDK`, `SPCX`, `TSLA`. Get contract addresses from base.org/stocks.
- **Issued ≠ tradeable. Verified 2026-09-03 across every DEX indexed on Base:** four tokens
  have real liquidity — NVDA $2.5M (24h volume $8.5M), GOOGL $1.45M ($4.3M), AAPL $1.22M
  ($3.5M), META $926k ($3.7M) — each deepest in an Aerodrome pair against USDC. The other
  nine (AMZN, COIN, CRCL, INTC, MSFT, MSTR, SNDK, SPCX, TSLA) have issued tokens and working
  Chainlink feeds but **no pool anywhere on Base**. They can show a reference price. They
  cannot be bought.
  Still **derive tradeability at runtime** rather than hardcoding that list: request an
  aggregator quote at the user's actual order size and render buy only if it comes back
  inside the price-impact budget. Depth is governed by weekly Aerodrome gauge votes, so the
  set will change. Calibrate impact to real ticket size — ₦50,000 is about $30, negligible
  even in a shallow pool.
- **Counterfeit tokenized stocks exist on Base right now. Guard against them in code.**
  The same sweep turned up fake NVDAc and GOOGLc tokens on Uniswap, one showing $610,081 of
  liquidity against $4 of 24h volume, alongside pairs like `googlc/ZORA` and `GOOGLc/googlc`.
  Large apparent TVL with no volume is the signature. **Real token addresses match `0xb2`
  followed by roughly twenty zeros.** It is that long run of zeros, not the `b2`, that makes
  the pattern trustworthy — it cannot be vanity-mined. Validate every token address against
  that shape before using it in a quote, an approval, or a transfer, and hard-fail if it
  does not match. Never resolve a token by symbol search.
- **AAPLc token address:** `0xb200000000000000000000C2e324d24d7eEcd1fb`
  Token addresses sit in the `0xb2…` precompile range. **Chainlink feed addresses are
  separate contracts** and look like ordinary addresses — do not confuse the two.
- **Feed freshness varies per token — do not model it as US market hours.** All 13 feeds
  verified: every `description()` matches its ticker (`Coinbase AAPL`, `Coinbase NVDA`, …)
  and every `decimals()` is 8. But at 10:45 UTC on a Thursday, with US markets shut, ages
  ranged from 29 minutes to 14h 53m. The crypto-correlated names were freshest — COIN 30m,
  CRCL 29m, MSTR 54m — because their fair value keeps moving overnight and deviation
  triggers keep firing. The megacaps were oldest: AAPL 13h 19m, NVDA 13h 15m, SPCX 14h 53m.
  So read `updatedAt` from each feed and render the real per-token age. Never derive
  freshness from a hardcoded market calendar and never show one global "market closed"
  banner — it would be wrong for half the grid at any given moment.
- **A stale reference is not an error and not a safety problem.** Execution price comes from
  the aggregator quote against pool liquidity; Chainlink is only the reference used to show
  premium or discount. When the reference is hours old, caption it — "reference 13h old" —
  because otherwise the premium figure reads as precise when it isn't. State age factually,
  never as an alarm. For a Lagos user this is the ordinary daytime condition, not an edge
  case: US hours are 13:30–20:00 UTC, which is 14:30–21:00 local.
- **Feed `decimals()` and token `decimals()` are different numbers.** The Chainlink feed
  returns 8. The B20 token returns something else. Read each from its own contract and
  never reuse one value for the other.
- **`mainnet.base.org` rate-limits hard.** Roughly a dozen `eth_call`s in quick succession
  is enough to start getting `over rate limit` back. Serialise reads, keep a short delay
  between them, and rotate across more than one public RPC. This matters for the markets
  grid, which reads a feed and a `decimals()` per token.
- **Token standard: B20.** An ERC-20 superset running as a native Base precompile.
  All standard ERC-20 calls behave normally. ERC-2612 `permit` is supported.
- **No holder allowlist.** Verified by simulating a transfer to an address with no
  Coinbase relationship — it succeeds. Any wallet can hold these tokens.
- **`decimals()` is NOT 18.** B20 has configurable precision. Always read `decimals()`
  from the contract and derive all formatting and order sizing from it.
  Hardcoding 18 produces silently wrong prices.
- **Dividends arrive as a multiplier update, not a cash distribution.** Current reading of
  the provider docs: holder balances do **not** change; a WAD-scaled multiplier moves the
  redemption ratio instead. Either way, `balanceOf × price` is wrong on its own — read the
  multiplier and apply it when valuing a position. Confirm the exact semantics against the
  issuer docs before writing any cost-basis or P&L logic.
- **Route through an aggregator, not a hardcoded venue.** 0x and 1inch both support these
  tokens and will find liquidity wherever it sits, which matters because most of the 13
  tokens have no Aerodrome pool. Do **not** install `@uniswap/v3-sdk`,
  `@uniswap/smart-order-router`, or any `@uniswap/*` package.
- **Chainlink reference feeds update 24/5; the pools trade 24/7.** Pool price drifts from
  the reference when US markets are closed.

## Verified Chainlink feed addresses

All 13 confirmed on 2026-09-03 by calling `description()` on each address and matching the
result against the ticker, plus `decimals()` (8 on every one) and `latestRoundData()`.
Use these as given — do not re-source or "correct" them.

```ts
export const CHAINLINK_FEEDS = {
  AAPL:  "0x787F13dEa48Db0897CbCDD985de77809D837F988",
  AMZN:  "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295",
  COIN:  "0x408e44f504A7371a345F03a73dDC96A4b48e8aa7",
  CRCL:  "0x0231cF2635D1E17bB5c2462cc7504Ba1fBd61f33",
  GOOGL: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
  INTC:  "0xAB657C39bac0D5886250D70849e2E3E008F2EECB",
  META:  "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
  MSFT:  "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c",
  MSTR:  "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a",
  NVDA:  "0x04689a41629776563E6822F76f2e57D148d28513",
  SNDK:  "0x388b0dC46C0Fb05A74BeE0994Fa5b02c6Fcca2eA",
  SPCX:  "0x6A634B235903C4ad6376892180d6fF8612e3Fa68",
  TSLA:  "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4",
} as const
```

**Token contract addresses are a different set** in the `0xb2…` precompile range and are
not listed here. Do not pass a feed address where a token address is expected.

## Rules

- **Use only the tokens in the Design system section below.** No ad-hoc colors, spacing
  values, radii, or shadows. If a value you need isn't defined, ask rather than inventing it.
- **All business logic in `/lib` and `/hooks`.** Components stay thin and presentational.
- **Every user-facing amount displays in NGN.** USDC is internal plumbing, never shown
  as the primary figure.
- **Read `decimals()` from chain.** Never assume.
- **Every buy shows price impact and premium vs the Chainlink reference**, including when
  the reference is stale because US markets are closed.
- **Do not load the wallet stack on pages that do not need it.** The app browses without a
  connected wallet, so wagmi has no business in the `/markets` first-load bundle. Read
  prices server-side and dynamically import the provider tree at the point of connection.
  Users are on Nigerian mobile data — a browsing page should not ship a wallet SDK.
- **No scratch or test routes in the deployed app.** `/rate-test` and anything like it gets
  deleted, not left behind for anyone who guesses the URL.

## Design system

Direction: **editorial finance** — warm paper canvas, graphite type, restrained emerald.
Light-first. Calm and still; motion only when it explains a change.

Define these as CSS custom properties and reference them everywhere. Never inline a hex.

```
--ink-950:       #151617   /* primary text, high-emphasis controls */
--graphite-800:  #292B2D   /* dark surfaces, charts, nav */
--graphite-600:  #5B5E62   /* secondary text, metadata */
--graphite-300:  #C9CBC8   /* dividers, disabled borders, gridlines */
--paper-50:      #F7F6F2   /* primary canvas */
--paper-100:     #EFEEE9   /* raised surfaces, section separation */
--white:         #FFFFFF   /* cards, modals, inputs */
--emerald:       #0E6B57   /* primary action, positive, ownership */
--emerald-soft:  #DCEDE7   /* positive bg, success, selected */
--red:           #B94A45   /* losses, failures, destructive ONLY */
--amber:         #8C5A18   /* warnings, quote expiry, market notices */
```

Emerald is not decoration. It is reserved for action, positive movement, ownership, and
trust moments. Red is strictly semantic and never a brand accent.

**Type.** Inter for everything; DM Mono for addresses, hashes, exact rates, and technical
identifiers. Both via `next/font/google`. Sentence case, left aligned. No all-caps headlines;
uppercase only for small labels.

```
display  72/0.98  w500    h1     48/1.04  w500    h2  32/1.10  w500
h3       22/1.20  w600    body-l 18/1.45  w400    body 15/1.45 w400
label    11/1.20  w600 uppercase +6% tracking     data 14/1.20  w500
```

**Space.** 4px base. Only these steps: 4, 8, 12, 16, 24, 32, 48, 64, 96.
**Radius.** 12px default, 20px for feature panels and the trade sheet. Pill only for a single
hero CTA. **Borders.** 1px `--graphite-300`. Almost no shadow — cards are quiet surfaces,
not floating tiles.

**Grid.** 12 columns, max content width 1280px, 32px gutters. Mobile: 4 columns, 20px gutters.

**Motion.** One ease-out curve for entrances, quick ease-in-out for state changes.
Page entrance fade + 12px rise over 500ms, staggered. Price update = 250ms soft tint flash.
Tab change 180ms. Trade review expands 240ms. No infinite spinners if a step label exists.
No shake on error — inline explanation and retry. Honour `prefers-reduced-motion` by dropping
parallax, stagger, and celebratory effects while preserving state clarity.

**Copy voice.** Plain language, short sentences, specific outcomes. "Add money", "Buy shares",
"Withdraw to your bank" — never "initiate fiat onramp" or "offramp liquidity". State risk
without drama. No hype, urgency, or guaranteed-return language, ever.

Say "You'll receive approximately 0.42 shares", not "Secure your allocation."
Say "Your quote expires in 30 seconds", not "Act now."

**Trade panel is the highest-trust component.** Always visible: what they pay, what they
receive, the conversion rate, price impact, estimated gas, and quote expiry. Never hide any
of them. Never imply an estimate is exact.

**Gate at the moment of action, not before.** The whole app is browseable without a
connected wallet. US-person ineligibility, wrong network, and low balance each get a direct,
respectful message with exactly one clear next action.

## Markets page structure

Two groups, because only four of the thirteen can actually be bought.

**Tradeable** — the tokens an aggregator will quote. Full market cards: company name,
ticker, NGN price, 24h change, buy action.

**Listed, not yet tradeable** — the remaining nine. Reference price only, visibly quieter
than the first group, with no buy affordance at all. Not a disabled button — a disabled
button invites clicking and then explains nothing. One line above the group is enough:
these stocks are issued on Base but have no pool yet, so they cannot be bought here.

Do not label that group "coming soon" or otherwise imply arrival. Liquidity depends on
Aerodrome gauge votes that Bourse does not control, so promising it would break the no-hype
rule. State the present condition and stop.

Group membership is derived, never authored. A token belongs in the first group when a quote
returns inside the price-impact budget. Until the aggregator lands in Phase 3, a provisional
flag in the registry is acceptable only if it is commented as temporary and deleted the
moment real quotes work.

**24h change comes from pool data, not Chainlink.** Walking `getRoundData` backwards is both
expensive and wrong: feeds go 14h+ between updates, so two consecutive rounds are often less
than 24 hours apart. Use `priceChange.h24` from DexScreener's
`/latest/dex/tokens/{address}` — also the more honest number, because it is the price users
actually transact at. So 24h change exists only for the four tokens with pools; the other
nine show no change figure rather than a fabricated one. DexScreener is unauthenticated with
no SLA, so a missing figure must degrade gracefully rather than break the card.

## Testing

`npm test` must run fully offline and deterministically — no network, no RPC, no third-party
APIs. Mock at the boundary.

Since you cannot execute anything, `npm test` is the human's only feedback loop. A suite that
goes red because an RPC rate-limited trains us to ignore red, which is worse than no test at
all.

Chain reads move to a separate `npm run verify:chain` script, invoked deliberately after an
address or ABI change.

## Stack

Next.js (App Router), TypeScript, wagmi v2 + viem.
Swaps route through an aggregator (0x or 1inch) — never a hardcoded DEX router.

### Dependency stub in `next.config` — leave it alone

`wagmi/connectors` is a barrel that pulls in every connector, including `baseAccount`,
which reaches `@base-org/account` → `@coinbase/cdp-sdk` → `@x402/*`. Those are optional
deps that are deliberately not installed, so webpack fails to resolve them at build time.

`next.config` aliases `@x402/core`, `@x402/evm`, and `@x402/svm` to `false` to cut that
dead branch. **Do not remove the alias and do not install `@x402/*`, `@base-org/account`,
or `@coinbase/cdp-sdk` to satisfy it.** Bourse uses none of that code — `@x402/svm` alone
would drag the whole Solana stack into a Base-only app. The "export not found" warnings
from `signX402Payment.js` are expected and do not fail the build.

Same reasoning for the audit report: the vulnerabilities are almost all transitive through
the WalletConnect and MetaMask SDKs in that unused barrel. Never run `npm audit fix --force`.

## Out of scope for v1

No charts, limit orders, transaction history, settings page, or news feed.
Do not add them unprompted.

**Light theme only.** Dark tokens exist in the design direction but are not built in v1 —
do not add a theme toggle. Structure the CSS variables so a dark theme can be added later
without touching components.

**No sparklines in v1.** They need 7-day price history, which we have no data source for yet.
Market cards ship with price and 24h change only.
