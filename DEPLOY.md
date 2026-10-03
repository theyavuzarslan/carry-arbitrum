# Deploy — 15-minute checklist

Primary path: **Robinhood Chain testnet** (chainId 46630, free gas). That alone satisfies "deployed on an Arbitrum chain" and targets the Robinhood/USDG prize. Secondary: the factory on Arbitrum Sepolia. Mainnet is at the end.
Deployer: `0x8c8370EC63923CB3E1B32192b0926c6dc11820Fa` (0.0099 test ETH on Robinhood testnet = ~100 deploys; 0 ETH on Arbitrum Sepolia).
Everything runs from `contracts/`. All commands were dry-run (simulated, nothing sent) from that address on 2026-10-04.

## 1. Signing, once (1 min)

**(a) Recommended: keystore.** Paste the key at the hidden prompt and pick a password. It is stored encrypted in `~/.foundry/keystores/`:
```bash
cast wallet import parity-deployer --interactive
cast wallet address --account parity-deployer     # must print 0x8c8370EC63923CB3E1B32192b0926c6dc11820Fa
```
**(b) Alternative: the existing .env.** In the same shell (the key stays in a variable and is never typed):
```bash
set -a; source "/Users/0xatakan/Claude Code/Parity on Robinhood Chain/.env"; set +a
```
The script below uses `$PRIVATE_KEY` if it is set, otherwise the `parity-deployer` keystore. If you run `forge` by hand with (b), pass `--private-key "$PRIVATE_KEY"`, the variable and never the literal.

## 2. Optional, 2 min: get testnet USDG for the seed deposit

https://faucet.paxos.com/ → USDG → "Robinhood Testnet" → `0x8c83…20Fa`. With ≥ 1 USDG the script also deposits 1 USDG, so the vault shows a real Paxos-USDG deposit on-chain. Without it the vault still deploys over real USDG, just with no deposit.
If the faucet fails and you want a deposit anyway, use `USE_MOCK_USDG=true` (deploys `MockUSDG`, mints 10,000 and deposits 1). Real USDG is the stronger story for the Paxos bonus, so prefer real USDG even if it means no deposit.

## 3. Deploy the USDG vault on Robinhood Chain testnet (2 min, one command)

```bash
cd contracts
./script/deploy-testnet.sh                       # real Paxos testnet USDG 0x7E95…802F
# or: USE_MOCK_USDG=true ./script/deploy-testnet.sh
```
It checks the chain id and balances, deploys, verifies on the testnet Blockscout (`explorer.testnet.chain.robinhood.com`, no API key), and prints explorer links for every contract plus the seed-deposit tx. With a keystore, forge asks for the password.
Dry-run results from `0x8c83…20Fa` (nonce 54):

| Mode | Gas | Test ETH | Predicted addresses |
| --- | --- | --- | --- |
| real USDG (deployer holds 0 USDG → no seed) | 3,906,730 | 0.000078 | CarryVault `0x330677cDA0fc0C7a184A3a150fb08De973A9C4F1` |
| `USE_MOCK_USDG=true` | 4,740,267 | 0.000095 | MockUSDG `0x330677cD…C4F1`, CarryVault `0x172B6169285eE59CD24D1669517513c75A28236A` |

Addresses shift if the wallet sends any other tx first. Trust the script's output.
Defaults: owner = operator = fee recipient = deployer, deposit cap 10,000 USDG. To change them, set `OPERATOR`, `FEE_RECIPIENT`, `DEPOSIT_CAP`, `SEED_DEPOSIT`.
To simulate again without a key: `DRY_RUN=1 DEPLOYER=0x8c8370EC63923CB3E1B32192b0926c6dc11820Fa ./script/deploy-testnet.sh`.

## 4. Secondary: CarryAccountFactory on Arbitrum Sepolia (3 min)

Top up ~0.001 Sepolia ETH (the dry run needs 0.00033) at https://www.alchemy.com/faucets/arbitrum-sepolia or https://faucet.quicknode.com/arbitrum/sepolia, or bridge Sepolia ETH at https://bridge.arbitrum.io. Then:
```bash
export ARBISCAN_API_KEY=...        # optional; free Etherscan v2 key from etherscan.io, enables verification
./script/deploy-testnet.sh sepolia
```
Dry run: 3,211,588 gas, 0.00033 ETH, predicted CarryAccountFactory `0x71da6a936f1196881C236c62a084ddEB448772Ba` (nonce 0).
It is wired to Aave v3 Pool `0xBfC91D59…2Eff`, its oracle `0xEf95A6B9…5c00` (read from the Pool's `ADDRESSES_PROVIDER`) and Uniswap SwapRouter02 `0x101F443B…663E`, and all three have code. The leveraged wstETH/WETH loop itself needs Aave e-mode 7 and a liquid Uniswap pool, which only Arbitrum One has; the fork tests prove the loop there.
Optional USDG vault on Sepolia (Paxos testnet USDG `0xFFC95faa…1892`): `forge script script/Deploy.s.sol:DeployArbitrumVault --rpc-url arbitrum_sepolia --account parity-deployer --broadcast`.

## 5. Manual verification (only if the script's verification failed)

Robinhood testnet explorer is Blockscout (https://explorer.testnet.chain.robinhood.com), no API key:
```bash
forge verify-contract <VAULT> src/CarryVault.sol:CarryVault --chain 46630 \
  --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api/ \
  --constructor-args $(cast abi-encode "constructor(address,string,string,address,address,address,uint256)" \
    <ASSET> "Carry USDG Vault (testnet)" "cvUSDG" <DEPLOYER> <OPERATOR> <FEE_RECIPIENT> 10000000000)
# if you used the mock:  forge verify-contract <MOCK> src/mocks/MockUSDG.sol:MockUSDG --chain 46630 --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api/
```
`<ASSET>`, `<OPERATOR>`, `<FEE_RECIPIENT>` are the values the script logged.

Arbitrum Sepolia uses Sepolia Arbiscan via the Etherscan v2 API. Get a free key at etherscan.io; one key covers every chain.
```bash
export ARBISCAN_API_KEY=...
forge verify-contract <FACTORY> src/CarryAccountFactory.sol:CarryAccountFactory --chain 421614 --watch \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" \
    0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff 0xEf95A6B9e88Bd509Fd67BA741cf2b263DaC65c00 0x101F443B4d1b059569D643917553c771E1b9663E)
```
(Shortcut: add `--verify` to an Arbitrum `forge script … --broadcast` command.)

## 6. Paste the addresses (2 min)

Copy the links the script printed.
1. `SUBMISSION.md`, line 5 (`deployed contract addresses ____`):
   - `CarryVault (Paxos USDG), Robinhood Chain testnet: https://explorer.testnet.chain.robinhood.com/address/<VAULT>`
   - the seed-deposit tx link, if there is one
   - `CarryAccountFactory, Arbitrum Sepolia: https://sepolia.arbiscan.io/address/<FACTORY>`, if you did step 4
2. The deck's last slide: the same links, labelled "Robinhood Chain testnet (USDG)" and "Arbitrum Sepolia".

---

## Alternative: mainnet

Needs real ETH: about 0.002 ETH on Arbitrum One and 0.001 ETH on Robinhood Chain. The dry runs used 3.1–3.6M gas at ~0.02 gwei, about 0.00015 ETH per deploy, so these amounts leave over 5× headroom for the L1 data fee. To get ETH onto Robinhood Chain (4663), bridge a little from Arbitrum One with LI.FI (jumper.exchange) or the official bridge linked from docs.robinhood.com/chain.

```bash
forge script script/Deploy.s.sol:DeployArbitrum       --rpc-url arbitrum  --account parity-deployer --broadcast   # factory
forge script script/Deploy.s.sol:DeployRobinhoodVault --rpc-url robinhood --account parity-deployer --broadcast   # USDG 0x5fc5…d168
forge script script/Deploy.s.sol:DeployArbitrumVault  --rpc-url arbitrum  --account parity-deployer --broadcast   # optional USDC vault
```
To verify, use the same commands as above with `--chain 42161` (factory: Arbitrum One constructor args `0x794a61358D6845594F94dc1DB02A252b5b4814aD 0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`) or `--chain 4663` (vault, robin.etherscan.io via the same Etherscan v2 key; or Blockscout `--verifier-url https://robinhoodchain.blockscout.com/api/`, untested).

**GMX UI fee (mainnet only, Arbitrum One).** Send this from the fee-receiver wallet (`CARRY_UI_FEE_RECEIVER`), because GMX records the factor for `msg.sender`. 5 bps = `5e26`; GMX caps it at `1e27` (10 bps).
```bash
cast send 0x7dE39FF2e232A2203196788d37e234cF8F1b83f1 "setUiFeeFactor(uint256)" 500000000000000000000000000 \
  --rpc-url arbitrum --account <fee-receiver-keystore>
```
Checked 2026-10-04: selector `0x5a03cd94` is in the ExchangeRouter bytecode, a simulated call with `5e26` succeeds, and `2e27` reverts `InvalidUiFeeFactor(2e27, 1e27)`.
