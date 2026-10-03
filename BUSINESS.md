# Carry — business and fee model

## Who it is for

| Segment | Their problem | What they use |
| --- | --- | --- |
| **Active DeFi users** ($5k–$500k on Arbitrum) | Idle stables, debt on the dearer venue, unhedged spot while perp shorts are paid double digits. They can't join five data sources to see it. | Free wallet scan, then one-click plans they sign themselves |
| **Tokenized-stock holders on Robinhood Chain** | They hold SPY, QQQ or SPCX tokens that earn nothing, while GMX pays shorts on the same stocks. | Cross-chain basis: keep the stock, add a GMX short, earn the funding |
| **Treasuries, DAOs and small funds** | They want market-neutral USD yield with controls, not a dashboard. | Managed CarryVaults with risk limits, or the API |
| **Wallets and front-ends** | They want to show "your wallet could earn more" without building it. | Wallet-scan and opportunity API |

## How Carry makes money

Carry never takes custody in self-custody mode, so it earns through the venues' own integrator hooks. Every fee is shown inside the net APR the user sees.

| Stream | Mechanism | Rate | Status |
| --- | --- | --- | --- |
| **Perp execution** | GMX v2 `uiFeeReceiver` on every order the bot builds. GMX caps this at 10 bps (on-chain `MAX_UI_FEE_FACTOR`, read 2026-10-04). | **5 bps** of position size, on open and close | Built (`CARRY_UI_FEE_RECEIVER`) |
| **Bridge execution** | LI.FI integrator fee on cross-chain legs, forwarded to Carry's fee wallet at execution | **10 bps** of the bridged amount | Built (`CARRY_LIFI_INTEGRATOR`) |
| **Managed vaults** | ERC-4626 CarryVaults: USDC on Arbitrum One, USDG on Robinhood Chain | **10% performance fee** on realized carry above a high-water mark, **0% management fee** | Roadmap (milestone 2) |
| **Pro / API** | Scanner, wallet-scan and plan API with alerts, for desks, DAOs and wallets | **$499 / month** per seat or integration | Roadmap (milestone 3) |
| **Free tier** | Market scan, wallet scan, plans, dashboard | $0 | Built |

The free scan is the acquisition loop. Every wallet scan ends in a plan the user can sign, and signing routes through the fee hooks.

### Why these rates

- **5 bps on perps** is half of GMX's cap. On a funded basis trade (66% of capital hedged, opened and closed once a month) it costs the user about 0.8% a year, against carry of 5–15%.
- **10 bps on bridges** sits under the quoted bridge cost itself (0.18–0.37% one way today), so Carry's fee never dominates the route.
- **10% performance and no management fee** means Carry earns only when users do. On an 8% net carry, the user keeps 7.2%.

## Unit economics (12 months, stated assumptions)

| Driver | Conservative | Base | Upside |
| --- | --- | --- | --- |
| Vault AUM (average) | $2M | $10M | $50M |
| Net carry before fee | 8% | 8% | 8% |
| Self-custody perp notional traded (open + close) | $20M | $100M | $500M |
| Bridged volume | $5M | $25M | $100M |
| API seats or integrations | 0 | 5 | 20 |
| **Vault performance fee** (10% × AUM × 8%) | $16k | $80k | $400k |
| **Perp execution** (5 bps) | $10k | $50k | $250k |
| **Bridge execution** (10 bps, before LI.FI's share) | $5k | $25k | $100k |
| **API** ($6k / year each) | $0 | $30k | $120k |
| **Revenue** | **~$31k** | **~$185k** | **~$870k** |

These are planning assumptions, not traction. Carry has no users or AUM today. LI.FI may keep a share of integrator fees depending on volume; the table shows the gross.

**Costs.** The main costs are private RPCs and data ($500–2,000 a month), an audit before vaults hold outside money ($30–80k), and keeper gas. Keeper gas is cents per transaction on Arbitrum.

## Why it can win the market

- **Arbitrum-native edge.** GMX, Aave, Compound and Uniswap on Arbitrum One, and tokenized stocks on Robinhood Chain, are one ecosystem connected by one-transaction bridges. Carry is the layer that sees across all of it.
- **The data is the moat.** Joining rates with the right units, depth-capped capacity and risk scoring is the hard part. It is also reusable: the same engine powers the free scan, the vaults and the API.
- **Distribution through wallets.** The wallet scanner turns a public address into dollars per year. That is a shareable result, and an API wallets can embed.

## Go-to-market

1. **Weeks 0–4.** A public dashboard with live scans, and wallet-scan links shared on X. Target holders of Robinhood Chain stock tokens and Aave borrowers with idle stables.
2. **Months 1–3.** Launch a guarded vault on Robinhood Chain in USDG, with a capped deposit limit and a public risk page. Launch partners: Robinhood Chain ecosystem wallets and Arbitrum DAO treasuries.
3. **Months 3–6.** API for wallets and portfolio trackers, priced per integration.

## Milestones (prizes are milestone-tied)

| # | Milestone | Proof |
| --- | --- | --- |
| 1 | Mainnet deployment: CarryAccount on Arbitrum One, fee hooks live, first live trades | Deployed addresses, transactions on Arbiscan, fee receipts |
| 2 | USDG CarryVault on Robinhood Chain (ERC-4626, high-water-mark performance fee) with an audit | Vault address, audit report, first deposits |
| 3 | Unwind automation and cross-chain exits; API launch | Bot closes positions on its own; first API customer |

## Risks to the business

- **Funding regimes change.** Perp carry can disappear for weeks. Vaults rotate across seven strategy families and fall back to lending yield.
- **Tokenized-stock rules.** Issuer eligibility and market-hours pricing limit who can hold the stock leg. Carry flags this in every such trade.
- **Venue dependence.** If GMX lowers the UI-fee cap or LI.FI changes its fee share, execution revenue drops. Vault and API revenue do not depend on either.
- **Smart-contract risk.** It grows with vault AUM. That is why the audit sits before outside deposits, not after.
