# Fork evidence

Each log is the raw output of `node src/cli.ts execute <id> --mode fork --capital <usd>` against an anvil fork of Arbitrum One at the block printed at the top. A fresh account is given ETH and buys its USDC capital on the forked Uniswap WETH/USDC pool; after that, every transaction is the bot's own and must succeed (each one is simulated first, then its receipt checked).

| File | Trade |
| --- | --- |
| fork-arb-basis.log | Long ARB (Aave) / short GMX ARB/USD, $10k |
| fork-reverse-basis.log | Borrow WETH on Aave, sell, long GMX ETH/USD [ETH-ETH], $10k |
| fork-lst-loop-carryaccount.log | 5x wstETH loop in Aave e-mode 7 via CarryAccount.openLoop, $8k |
| fork-lst-loop-compound-iterative.log | 5x wstETH loop on Compound cWETHv3 as 15 plain rounds, $8k |

GMX orders remain pending on a fork: keepers, which fill orders at signed oracle prices, do not run there. The order key is read back from the GMX DataStore (`ACCOUNT_ORDER_LIST`) as proof the order exists. The first ARB run failed with `InsufficientExecutionFee(4177115511238881, 600000000000000)`; the executor now sizes the fee from the gas price (docs/VERIFICATION.md).
