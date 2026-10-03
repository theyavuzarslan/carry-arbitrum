# Deployments

## Robinhood Chain testnet (chain 46630)

Deployed 2026-10-04 from `0x8c8370EC63923CB3E1B32192b0926c6dc11820Fa` with `contracts/script/deploy-testnet.sh`.

| Contract | Address | Status |
| --- | --- | --- |
| CarryVault ("Carry USDG Vault (testnet)", cvUSDG) | [`0x330677cDA0fc0C7a184A3a150fb08De973A9C4F1`](https://explorer.testnet.chain.robinhood.com/address/0x330677cDA0fc0C7a184A3a150fb08De973A9C4F1) | Source verified on Blockscout |
| Asset: Paxos USDG (testnet) | [`0x7E955252E15c84f5768B83c41a71F9eba181802F`](https://explorer.testnet.chain.robinhood.com/address/0x7E955252E15c84f5768B83c41a71F9eba181802F) | Official Paxos testnet USDG |

Transactions, all status 1:

- deploy: [`0xf5f2…0de4`](https://explorer.testnet.chain.robinhood.com/tx/0xf5f25443acfdf3bcab1e6ba716a18ca8f69960f47a382b257e84b95c44800de4)
- approve USDG: [`0x79b5…c314`](https://explorer.testnet.chain.robinhood.com/tx/0x79b57bc5f32244bd57fa845b8e5f909588b39e060afad7fd78605c11101bc314)
- seed deposit of 1 USDG: [`0xd02f…450d`](https://explorer.testnet.chain.robinhood.com/tx/0xd02f8efb6d7278ded9d9ca480da19005b2fc93603a8139df8d4d6fb9d414450d)

On-chain state read back after deployment:

| Field | Value |
| --- | --- |
| `totalAssets` | 1.000000 USDG |
| `totalSupply` | 1e12 shares (decimals offset 6) |
| `performanceFeeBps` | 1000 |
| `depositCap` | 10,000 USDG |
| `owner` | the deployer |

## Not deployed yet

- **CarryAccountFactory on Arbitrum Sepolia.** It needs about 0.001 Sepolia ETH; the deployer holds 0. Run `./script/deploy-testnet.sh sepolia` after a faucet top-up.
