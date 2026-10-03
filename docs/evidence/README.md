# Fork evidence

Each log is the raw output of `node src/cli.ts execute <id> --mode fork --capital <usd>` against an anvil fork of Arbitrum One at the block printed at the top. A fresh account is given ETH and buys its USDC capital on the forked Uniswap WETH/USDC pool; after that, every transaction is the bot's own and must succeed (each one is simulated first, then its receipt checked).

| File | Trade |
| --- | --- |
| fork-arb-basis.log | Long ARB (Aave) / short GMX ARB/USD, $10k |
| fork-reverse-basis.log | Borrow WETH on Aave, sell, long GMX ETH/USD [ETH-ETH], $10k |
| fork-lst-loop-carryaccount.log | 5x wstETH loop in Aave e-mode 7 via CarryAccount.openLoop, $8k |
| fork-lst-loop-compound-iterative.log | 5x wstETH loop on Compound cWETHv3 as 15 plain rounds, $8k |
| fork-xchain-basis-spcx.log | Bridge USDC → SPCX on Robinhood Chain via LI.FI + GMX SPCX/USD short on Arbitrum One, $5k |

GMX orders remain pending on a fork: keepers, which fill orders at signed oracle prices, do not run there. The order key is read back from the GMX DataStore (`ACCOUNT_ORDER_LIST`) as proof the order exists. The first ARB run failed with `InsufficientExecutionFee(4177115511238881, 600000000000000)`; the executor now sizes the fee from the gas price (docs/VERIFICATION.md).


All three GMX runs read their order key back from the DataStore (ARB `0xf98d…45eb`, reverse basis `0xca97…1de7`, SPCX `0x12dd…c057`). An earlier note here claimed the reverse-basis key was missing; that was a display filter hiding lines that start with `"0x`, not a missing order.

**Cross-chain run.** Only the Arbitrum One side is observable on a fork: the LI.FI transaction (symbiosis route) succeeds and the USDC leaves the account, but nothing runs on Robinhood Chain. In live mode the executor polls LI.FI's `/status` until the transfer is `DONE` before it opens the GMX short, and stops if it fails.
