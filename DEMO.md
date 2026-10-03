# Demo video: shot list (about 3 minutes)

You don't need every case. Show one scene per judging criterion and point to the repo for the rest. Every scene is a command in `scripts/demo.sh`, so nothing has to be found by hand.

```bash
./scripts/demo.sh        # all scenes, press enter between them
./scripts/demo.sh 4      # one scene
```

Live numbers change hourly. That's fine: say "live right now".

| # | Time | Criterion | Run | Say (one or two lines) |
| --- | --- | --- | --- | --- |
| 0 | 0:00–0:15 | Intro | Deck cover slide | "Carry is a carry-trade agent for Arbitrum One and Robinhood Chain. It finds, sizes and executes carry, and tells any wallet what it's missing." |
| 1 | 0:15–0:40 | Real problem solving | `./scripts/demo.sh 1` | "Live scan of Aave, Compound, GMX, Pendle, staking and Uniswap depth. Every row is net of swap, bridge and perp fees, with a risk grade and real capacity. Top: BTC cash-and-carry, about 15%, grade A." |
| 2 | 0:40–1:00 | Innovation | `./scripts/demo.sh 2` | "Some assets don't exist on Arbitrum One. GMX lists stock and commodity perps; the spot lives on Robinhood Chain. Carry bridges into the token with LI.FI and shorts GMX." |
| 3 | 1:00–1:25 | Product-market fit | `./scripts/demo.sh 3` | "Paste any wallet. This real Aave borrower sits at health factor 1.13. Carry flags it first, with the exact repayment, then finds a cheaper venue for their debt." |
| 4 | 1:25–1:55 | Real problem / safety | `./scripts/demo.sh 4` | "Before any trade: GoPlus token security, plus entry and exit liquidity at the real size. A $50k SPCX trade would be 117% of GMX's market and flip the funding, so it's blocked. The GMX-token trade is blocked because its owner can change balances." |
| 5 | 1:55–2:15 | Execution | `./scripts/demo.sh 5` | "Plans are exact transactions with exact approvals, each simulated before it's sent. Fees are charged through GMX's and LI.FI's own integrator hooks." |
| 6 | 2:15–2:35 | Smart contract quality | `./scripts/demo.sh 6` | "CarryAccount opens a 5x wstETH loop in one flash-loan transaction, on a fork of Arbitrum One. Health factor 1.199, exactly what the scanner predicted. Ten fork tests." |
| 7 | 2:35–2:55 | Deployed + USDG | `./scripts/demo.sh 7`, then the explorer link in a browser | "Our USDG vault is live and verified on Robinhood Chain testnet, holding real testnet USDG, with a 10% fee only above its high-water mark." |
| 8 | 2:55–3:10 | Business | Deck fees slide | "We earn when users earn: 5 bps on perps, 10 bps on bridges, 10% vault performance fee." |

## Optional extras, if you have time

- **Dashboard.** Run `node src/cli.ts serve` and open http://localhost:8787. Click a row, then "Build plan". It's a good 10-second B-roll over scene 1 or 5.
- **Live fork run.** `node src/cli.ts execute basis:arbusdarb-usdc:arb:funded --mode fork --capital 10000` takes 5–15 minutes on a public RPC. Record it beforehand and speed the clip up, or just show the saved log in scene 6.

## Recording tips (macOS)

- Press Cmd+Shift+5 and choose "Record Selected Portion". Turn on the microphone in Options.
- Set the terminal font to 18–20 pt and make the window about 120 columns wide, so the tables don't wrap.
- Run `./scripts/demo.sh` once before recording. That warms the 60-second data cache and the 24-hour GoPlus cache, so scenes print instantly.
- If a scene's numbers look odd that day, skip it. The repo has the evidence.
