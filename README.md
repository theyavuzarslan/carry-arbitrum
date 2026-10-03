# Carry — an onchain carry desk for Arbitrum

Carry is a bot that finds carry trades on Arbitrum, sizes them, scores their risk, and executes them through Aave v3, Compound v3, Uniswap v3 and GMX v2. It scans two things:

- **The market.** Every lending rate, perp funding rate, staking yield and fixed-rate PT on Arbitrum, joined into ranked trades.
- **Your wallet.** What you hold and owe across Aave, Compound, GMX and Pendle, the carry you earn today, and the specific moves that would earn more.

"Carry" here means any position whose return comes from holding it, not from price moving: funding paid to one side of a perp, the gap between a borrow rate and a supply rate, staking yield on leverage, a fixed PT yield over a floating one. Classic FX carry (borrow the low-rate currency, hold the high-rate one) is one family among seven.

```
node src/cli.ts scan                                   # rank every carry trade on Arbitrum right now
node src/cli.ts wallet 0xAFfD35301381265Ed740098A2394894B3A2d6500
node src/cli.ts plan 1 --capital 10000                 # exact transactions, nothing sent
node src/cli.ts execute <id> --mode fork               # run it on an anvil fork of Arbitrum One
node src/cli.ts run --mode dry-run --interval 300      # the bot loop
node src/cli.ts serve                                  # dashboard on http://localhost:8787
```

## What it found on 2026-09-30

Live output from `node src/cli.ts scan --exec` (rates move; rerun it):

| Trade | Net APR | Risk | Why it pays |
| --- | --- | --- | --- |
| Borrow WETH on Aave, sell it, long GMX ETH/USD [ETH-ETH] | 9.7% | B | GMX pays ETH longs ~17%/yr in that pool; WETH costs 2.1% to borrow. Covered FX-style carry. |
| Long ARB / short GMX ARB/USD | 5.3% | A | GMX pays ARB shorts ~14.9%/yr. Cash-and-carry. |
| Borrow USDC on Aave 3.9%, supply GHO 8.5% | 6.3% | B | Stablecoin rate carry. |
| 5x wstETH loop on Compound (cWETHv3) | 3.5% | C | 2.27% staking vs 1.46% WETH borrow, levered. |

The scanner also shows about 90 non-executable signals, such as Fluid and Morpho supply rates, sUSDai and Pendle PTs, and cross-venue funding against Hyperliquid, Binance and Bybit. They are labelled "info" and ranked lower.

## Cross-chain sourcing: Arbitrum ecosystem chains

Some carry exists on Arbitrum One only on one side. GMX lists perps on SPY, QQQ, SpaceX (SPCX), gold, silver and oil, but none of those trade as spot on Arbitrum One. When the bot finds a trade whose asset or pool is missing on Arbitrum One, it looks for it on the other Arbitrum chains: Robinhood Chain, Plume, ApeChain, Gravity and Arbitrum Nova. It then prices the bridge into the trade.

- **Asset discovery.** It reads LI.FI's token lists for those chains. A GMX perp is matched to a token there by symbol (`src/chains.ts`). An exact match must price within 3% of GMX's mark: tokenized SPY on Robinhood Chain sits 0.1% from GMX's SPY. ETF proxies such as SLV for silver and USO for oil are allowed but carry tracking-error risk points.
- **Yield discovery.** It reads DefiLlama pools on those chains, such as Morpho USDG vaults and USDe on Robinhood Chain, or Nest RWA vaults on Plume. Each is joined to a token LI.FI can deliver.
- **Bridge pricing.** It takes live LI.FI quotes from Arbitrum One USDC at $1k, $10k and $50k. One-way cost comes from the $10k quote and is charged on entry and exit. Depth is the largest size that costs under 1.5%. Quotes are cached for 15 minutes.
- **Two new strategy families.** `xchain-basis` holds the spot on the other chain and shorts GMX on Arbitrum One. `xchain-yield` either bridges USDC straight into the yield token, or keeps USDC collateral on Aave and bridges only the borrowed USDC. A vault that LI.FI can't deliver in one hop, such as Plume's Nest vaults, shows as a plan-only signal with the bridge leg priced.
- **Execution.** The bridge is one LI.FI transaction on Arbitrum One, quoted at send time with the real sender and amount, with an exact approval. In live mode the executor waits until LI.FI reports the transfer as delivered before opening the hedge.

Set `CARRY_XCHAIN=0` to turn the layer off and `LIFI_API_KEY` to lift LI.FI's keyless rate limit.

## Strategy families

| Family | Legs | Venues |
| --- | --- | --- |
| **basis** (cash and carry) | long spot + short perp. Funded (spot and USDC margin) or levered (spot as collateral, USDC margin borrowed against it). | Uniswap, Aave/Compound, GMX |
| **reverse-basis** | borrow spot against USDC, sell it, long the perp. Covered carry. | Aave/Compound, Uniswap, GMX |
| **lend-borrow** | borrow a cheap asset, deploy into a richer one of the same currency | Aave, Compound, (Fluid, Morpho, sUSDai as signals) |
| **fx-carry** | borrow a low-yield currency (ETH, BTC, EUR via EURS), hold a high-yield one, uncovered | Aave, Compound |
| **lst-loop** | wstETH/weETH collateral, WETH debt in e-mode, looped | Aave e-mode 2/7, Compound cWETHv3, CarryAccount contract |
| **fixed-carry** | Pendle PT fixed yield vs the best floating stable rate | Pendle (signal) |
| **funding-spread** | same perp on GMX vs Hyperliquid/Binance/Bybit | GMX + off-chain (signal) |
| **xchain-basis** | spot on an Arbitrum ecosystem chain + short GMX perp on Arbitrum One | LI.FI, Robinhood Chain / Plume, GMX |
| **xchain-yield** | bridge USDC (or Aave-borrowed USDC) into a yield that only exists on an ecosystem chain | LI.FI, Aave, Robinhood Chain / Plume |

Each opportunity carries its legs, gross APR, round-trip costs amortized over the holding horizon, net APR, leverage, capacity, a 0–100 risk score with reasons, and whether this bot can execute it.

## How the numbers are built

- **Rates are read at the source.** Aave and Compound rates, caps, LTVs, e-mode bitmaps and oracle prices come from the contracts over RPC. GMX funding and borrow rates come from GMX's API; their units were checked against the DataStore on-chain (see [docs/VERIFICATION.md](docs/VERIFICATION.md)). Staking yields come from Lido's API and DefiLlama.
- **Carry is signed from the holder's side.** Positive means the position is paid; borrow legs are negative.
- **Costs are real.** Swaps cost 2 bps (pegged pairs), 6 bps (majors) or 30 bps (others) each way. GMX costs 6 bps each way. Both are charged on entry and exit and amortized over 30 days by default (`--horizon`).
- **Capacity is the thinnest leg.** It is the smallest of: perp open-interest headroom, lending liquidity and caps, and **Uniswap depth within 1% price impact**, which is measured live with QuoterV2. GMX's own token absorbs about $1k, so a 10% GMX basis trade is shown with tiny capacity instead of topping the list.
- **Sanity filters.** GMX pools under $250k open interest are skipped, and funding above 300%/yr is treated as an artifact. Rates far above the CEX average get mean-reversion risk points.
- **Risk score.** Points for leverage, the price move to liquidation, capacity, funding regime, asset quality (depeg and issuer risk), uncovered FX volatility, off-Arbitrum legs and unintegrated venues. The ranking is net APR × (1 − risk/150).

## Wallet scanner

`wallet <address>` reads native and ERC-20 balances, Aave per-reserve supply and debt with the health factor and e-mode, Compound base and collateral balances, GMX positions (Reader), and Pendle PTs. It then suggests:

- supplying idle tokens where they earn most, or swapping idle WETH to wstETH;
- **repaying debt with idle balances of the same asset**, which beats any supply rate;
- moving a supply to a better venue, and refinancing debt to a cheaper venue;
- hedging idle spot with a GMX short when shorts are well paid;
- flagging GMX positions that bleed funding;
- deploying idle stables into the best executable market trade;
- **health-factor alerts** first.

Each suggestion shows the dollars per year it adds on the amount it touches.

## Execution

The planner turns an opportunity into actions (swap, supply, borrow, e-mode, GMX order). The compiler turns each action into exact transactions just before it is sent, so a supply uses the real output of the swap before it. Approvals are always exact, never unlimited. Every transaction is simulated before sending, so a revert reports its reason.

| Mode | What happens |
| --- | --- |
| `plan` | Compiles the transactions with live Uniswap quotes. Nothing is sent. |
| `fork` | Starts `anvil` on a fork of Arbitrum One, gives a fresh account ETH, buys the USDC capital on the real forked Uniswap pool, and sends every transaction. Each one must succeed. |
| `live` | Signs with `CARRY_PRIVATE_KEY`. Refuses without `--yes`, above `CARRY_MAX_CAPITAL_USD` (default $1,000) or above `CARRY_MAX_RISK`. |

GMX orders are two-step: the transaction creates an order, and a GMX keeper fills it at the next oracle price. On a fork there are no keepers, so the order stays pending. The bot reads its key from the DataStore to prove it exists. On mainnet a keeper fills it within seconds.

**Proven on a fork of Arbitrum One** (logs in [docs/evidence](docs/evidence)):

| Trade | Capital | Transactions | Result on the fork |
| --- | --- | --- | --- |
| ARB cash-and-carry | $10,000 | 6 | $6,667 ARB supplied to Aave; $6,667 GMX short with $3,529 USDC margin; GMX order key pending in the DataStore |
| Reverse basis (ETH) | $10,000 | 9 | 2.68 WETH borrowed on Aave and sold; $4,815 GMX long plus 0.893 WETH margin; delta-neutral; Aave HF 1.62 (target 1.60) |
| 5x wstETH loop via CarryAccount | $8,000 | 5 (swap, deploy, approve, openLoop) | $39,974 collateral, $32,004 debt, **5.02x, HF 1.199** (the scanner predicted 1.20) in one flash-loan transaction |
| 5x wstETH loop on Compound, iterative | $8,000 | 15 rounds (79 lines incl. approvals) | 11.18 wstETH collateral, 10.96 WETH debt, **4.67x** — why the flash-loan contract exists |
| SPCX cross-chain basis | $5,000 | 4 | $3,333 USDC sent through LI.FI into SPCX on Robinhood Chain; $3,314 GMX SPCX short with USDC margin; order key pending. The destination side is not observable on a fork. |

## The CarryAccount contract

[contracts/](contracts/) holds `CarryAccount`, a per-user smart account that opens and closes a leveraged LST loop on Aave v3 in **one transaction** using an Aave flash loan (swap on Uniswap, supply, borrow, repay the flash loan, check the health factor). The TypeScript executor deploys it and uses it for Aave LST loops in fork and live mode. That is 4 transactions instead of about 15. 10 Foundry fork tests pass against live Arbitrum state; see [contracts/README.md](contracts/README.md).

## The bot loop

`run` repeats every `--interval` seconds:

1. Snapshot all markets and rank.
2. Mark open positions to the current carry, accrue paper P&L, and exit after two scans below `CARRY_EXIT_NET_APR` (default 1%).
3. In fork or live mode, read the account's Aave health factor and flag deleveraging under `CARRY_MIN_HF` (1.3).
4. With free budget, enter the best executable trade with net ≥ 4%, risk ≤ 60 and capacity ≥ 3 tickets.

State and a log are kept in `.state/bot.json`, and the dashboard reads it.

## Dashboard

`node src/cli.ts serve`, then open http://localhost:8787 for the opportunity board with filters, a detail panel and a plan builder, plus market tables with a carry curve, a wallet view and the bot log. `web/index.html?demo=1` works with no backend from recorded fixtures. The wallet fixture and the examples use `0xAFfD…6500`, a public Arbitrum address picked from recent Aave borrow events; it is not ours and has no connection to this project.

## Setup

Needs Node 22.18+ (it runs TypeScript directly) and pnpm. Fork mode and contract tests need [Foundry](https://getfoundry.sh).

```
pnpm install
node src/cli.ts scan
pnpm test                 # unit tests on a frozen live snapshot
pnpm test:contracts       # Foundry fork tests
```

Set `ARB_RPC_URLS` to a private RPC for heavy use; the public fallbacks are rate-limited. All settings are env variables listed in `src/config.ts` and `src/bot.ts`.

## Limits, stated plainly

- Pendle, Fluid, Morpho, Dolomite, sUSDai and CEX legs are **signals only**; this build has no transaction builders for them.
- Unwinds are flagged by the bot but not auto-executed. Closing is manual, except for LST loops, which `CarryAccount.closeLoop` closes in one transaction.
- GMX funding is adaptive and changes hourly. The APRs are current rates, not forecasts.
- Refinancing across venues is suggested, not executed.
- Live mode has not been run with real funds in this build.
- Cross-chain trades were verified on the Arbitrum One side only; delivery on Robinhood Chain was never observed. Tokenized stocks may be subject to issuer eligibility rules, and their prices follow US market hours while GMX trades 24/7.
- Unwinding a cross-chain trade means bridging back; that route is not built yet.
