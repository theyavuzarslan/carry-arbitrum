# HackQuest form answers (copy-paste)

**Project name:** Carry

**One-liner:** An onchain carry-trade agent for Arbitrum One and Robinhood Chain. It finds, sizes, guards and executes carry trades, and tells any wallet the yield it is missing.

**Prize tracks:** Overall prize, and Promising Products (AI agents, new financial primitives).

**Sector tags:** DeFi, AI, RWA, Infra

**Tech stack:** Solidity, TypeScript, Foundry, viem

**GitHub:** https://github.com/theyavuzarslan/carry-arbitrum

**Deployed contract:** CarryVault (ERC-4626 over Paxos USDG) on Robinhood Chain testnet. Source verified, holds a 1 USDG seed deposit.

```
0x330677cDA0fc0C7a184A3a150fb08De973A9C4F1
```

https://explorer.testnet.chain.robinhood.com/address/0x330677cDA0fc0C7a184A3a150fb08De973A9C4F1

**Pitch deck:** https://claude.ai/artifact/LZRxgWawzdwcebhqanKJ11. Share it from its Share menu first, or export it to PDF and upload that.

**Demo video:** not yet.

## Description (short)

Carry trades on Arbitrum are real but scattered. GMX pays perp funding, Aave and Compound set borrow rates, Lido pays staking, Pendle locks fixed rates, and tokenized stocks live on Robinhood Chain. Carry joins all of them into ranked trades with net APR after every fee, a 0–100 risk score and real capacity. It then plans and executes them with exact approvals and a simulation before every send.

## Description (long)

**What it does**
- Scans Aave v3, Compound v3, GMX v2, Uniswap v3 depth, Pendle, staking yields and five Arbitrum ecosystem chains, all live.
- Ranks trades from nine carry families, including cash-and-carry, reverse basis, rate and FX carry, LST loops, fixed carry and funding spreads. Cross-chain basis holds stock tokens on Robinhood Chain against GMX shorts on Arbitrum One. It also flags one-off CEX–DEX and stock-token arbitrage.
- Scans any wallet and prices the dollars per year it is missing, with health-factor alerts first.
- Runs guardrails before every trade: GoPlus token security, plus entry and exit liquidity at the real size (Uniswap round trip, lending cash, GMX open-interest share, destination DEX depth).
- Executes in plan, fork or capped live mode. CarryAccount opens a 5x wstETH loop in one Aave flash-loan transaction: 5.02x and health factor 1.199 on a fork of Arbitrum One, exactly as the scanner predicted.
- CarryVault is a USDG ERC-4626 vault with a 10% performance fee above a high-water mark. It is deployed and verified on Robinhood Chain testnet.

**Business model.** 5 bps on GMX positions via the UI-fee hook. 10 bps on bridges via the LI.FI integrator fee. 10% vault performance fee. A paid API. Every fee is already included in the net APR the user sees.

**Evidence.** 27 Foundry tests, 26 unit tests, and five trades executed on forks of Arbitrum One (logs in `docs/evidence`).
