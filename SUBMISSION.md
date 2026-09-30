# Carry — submission

> **Fill in before submitting:** hackathon name: `____`. Track: `____`. Team: `____`. Demo video: `____`. Repo URL: `____`.

## One line

Carry is an onchain carry desk for Arbitrum. It ranks every carry trade across Aave, Compound, GMX, Uniswap, Pendle and staking. It tells a wallet which carry it is missing, and it executes the trades, including a one-transaction flash-loan loop contract.

## Problem

Carry on Arbitrum is scattered. Funding lives on GMX, borrow rates on Aave and Compound, staking yield on Lido, and fixed rates on Pendle. The best trades combine them, for example "borrow WETH on Aave, sell it, go long on GMX where longs are paid 17%". Finding one means joining five data sources with different units. Sizing it means knowing lending caps, perp open interest and DEX depth. Putting it on takes 6–15 transactions in the right order. Most holders never do it, and most wallets leave carry on the table: idle stables next to debt in the same asset, supplies on the worse venue, unhedged spot while shorts are paid double digits.

## What we built

1. **Market scanner.** It reads Aave v3 and Compound v3 on-chain (rates, caps, LTVs, e-mode bitmaps, oracle prices), GMX v2 funding and borrow rates (units verified against the DataStore), Hyperliquid/Binance/Bybit funding as a reference, DefiLlama lending rates, Lido staking and Pendle PTs. It measures Uniswap v3 depth live with QuoterV2.
2. **Seven strategy families.** Basis, reverse basis, lend-borrow, FX carry, LST loops, fixed carry and funding spread. Each opportunity has legs, gross and net APR after round-trip costs, leverage, capacity and a risk score with reasons.
3. **Wallet scanner.** It reads balances and Aave, Compound, GMX and Pendle positions, and turns them into dollar-per-year suggestions with health alerts first.
4. **Executor.** Planner and compiler with exact approvals and simulate-before-send, in three modes: plan, anvil fork of Arbitrum One, and capped live.
5. **CarryAccount contract.** A flash-loan LST loop open and close in one transaction, with 10 Foundry fork tests.
6. **Bot loop and dashboard.** Scan, enter under risk and budget gates, mark to market, exit on carry decay, and alert on health factor.

## Why it fits Arbitrum

Every executable leg is an Arbitrum-native venue: GMX v2 for perps, Aave v3 and Compound v3 for lending, Uniswap v3 for swaps. Arbitrum's cheap blocks are what make carry trades of $1k–$50k worth doing. A 6-transaction basis trade costs cents in gas, so the round-trip cost is almost all venue fees, and the bot models exactly those.

## Evidence

- `node src/cli.ts scan` runs against live Arbitrum in about 10 seconds. The ranked output is in the README.
- Fork runs of real trades on Arbitrum One state, with every transaction succeeding, are in [docs/evidence](docs/evidence).
- `pnpm test`: 11 unit tests on a frozen live snapshot. They check gross/net consistency, health-factor sizing, GMX calldata decoding and planner sequences.
- `pnpm test:contracts`: 10 Foundry fork tests for CarryAccount (3x open, close returns 99.76% of principal, access control, slippage and health-factor guards).
- [docs/VERIFICATION.md](docs/VERIFICATION.md) records how each address and rate unit was checked.

## What is not done

- Pendle, Fluid, Morpho, sUSDai and off-chain funding legs are signals, with no builders.
- Automated unwinds exist only for LST loops (via the contract). Other exits are flagged, not executed.
- Live mode is implemented and capped but was not run with real funds.
- GMX orders stay pending on a fork because keepers do not run there.
