# Carry Trade Bot — contracts

Onchain half of the carry-trade bot: a per-user smart account, `CarryAccount`, that opens and closes a
leveraged staking-carry loop on **Aave v3 Arbitrum** in **one transaction each**, using an Aave flash loan
and a Uniswap v3 swap. The TypeScript bot (elsewhere in this repo) decides *when* to open, close or
resize; this contract makes each action atomic and safe.

## The trade

Canonical pair: **wstETH collateral / WETH debt**, Aave e-mode category **7**
("wstETH/WETH ETH Correlated": LTV 94%, liquidation threshold 96%, liquidation bonus 1%).

1. Supply wstETH (earns Lido staking yield through wstETH's rising exchange rate).
2. Borrow WETH (pays Aave's variable WETH rate).
3. Swap the WETH to wstETH, supply it, repeat — except we do it in one shot with a flash loan.

For leverage `L = collateral / equity`:

```
net carry on equity ≈ stakingYield × L − wethBorrowRate × (L − 1)     (+ small wstETH supply APR × L)
```

Example (staking ~2.8% is a rough assumption, not measured onchain; WETH borrow ~2.1% was read from Aave at the pinned block):
`2.8% × 3 − 2.1% × 2 ≈ 4.2%` on equity at 3x, versus 2.8% unlevered. The trade is only worth running
while `stakingYield > borrowRate`; the spread, not the leverage, is the signal the bot watches.

Health factor at leverage L in e-mode 7 (collateral and debt priced by the same ETH-correlated oracle):

```
HF = 0.96 × L / (L − 1)          →   3x ≈ 1.44,  5x ≈ 1.20,  10x ≈ 1.07,  max LTV-allowed ≈ 16.7x
```

Because both legs are ETH, HF is insensitive to the ETH/USD price; it moves with the
wstETH/ETH exchange rate (which only goes up absent a slashing event) and with accrued WETH interest.

The contract is generic over `(collateral, debt, fee tier, eMode)`, so e.g. weETH/WETH works with the
right e-mode id and Uniswap fee tier. Only wstETH/WETH is tested.

## Contracts

| File | What it is |
| --- | --- |
| `src/CarryAccount.sol` | The account. `openLoop`, `closeLoop`, `executeOperation` (flash-loan callback), `rescue`, `position()`, `oracleConvert()`. |
| `src/CarryAccountFactory.sol` | Deploys one `CarryAccount` per `msg.sender`, records it in `accountOf`, emits `AccountCreated(owner, account)`. |
| `src/interfaces/*.sol` | Minimal local interfaces: `IPool`, `IFlashLoanSimpleReceiver`, `IERC20`, `ISwapRouter02`, `IAaveOracle`. |
| `src/libraries/SafeTransferLib.sol` | Tiny safe transfer/approve helpers (handles no-bool-return tokens and "approve to 0 first" tokens). |
| `src/CarryVault.sol` | ERC-4626 managed vault (USDG on Robinhood Chain, USDC/USDG on Arbitrum One) with a 10% high-water-mark performance fee. See [CarryVault](#carryvault). |
| `script/Deploy.s.sol` | `DeployRobinhoodTestnet` (USDG vault on Robinhood testnet, optional `MockUSDG` fallback, 1 USDG seed deposit), `DeployArbitrum` (factory, Arbitrum Sepolia or One), `DeployRobinhoodVault` (mainnet USDG vault), `DeployArbitrumVault` (USDG vault on Sepolia / USDC on One). Step-by-step in [`../DEPLOY.md`](../DEPLOY.md). |
| `script/deploy-testnet.sh` | One-command testnet deploy + Blockscout verification + explorer links (`robinhood` default, `sepolia`); `DRY_RUN=1 DEPLOYER=0x…` simulates. |
| `src/mocks/MockUSDG.sol` | Testnet-only 6-decimal token with open `mint`, fallback if the Paxos faucet is unavailable. |

### `openLoop(OpenParams)`

```
OpenParams { collateral, debt, eMode, fee, principal, targetLeverage (1e18), maxSlippageBps, minHealthFactor (1e18) }
```

1. `transferFrom` `principal` collateral from the owner, supply it to Aave, enter `eMode` (skipped if already in it).
2. `extra = principal × (L − 1)`; `flashAmount = oracleConvert(collateral → debt, extra)` using the Aave oracle.
3. `flashLoanSimple(debt, flashAmount)`. In the callback: `exactInputSingle` debt → collateral with
   `amountOutMinimum = extra × (1 − maxSlippageBps)`, supply the output, `borrow(debt, flashAmount + premium)`,
   approve the Pool to pull the repayment.
4. After the flash loan: `require(healthFactor >= minHealthFactor)`, emit
   `LoopOpened(collateral, debt, totalCollateral, totalDebt, healthFactor)` (token units; collateral and debt indexed).

Calling it again on an open position adds another leveraged slice (leverage is applied to the new
principal, not re-targeted for the whole position).

### `closeLoop(CloseParams)`

```
CloseParams { collateral, debt, fee, maxSlippageBps }
```

1. Read the current variable debt; `flashLoanSimple(debt, currentDebt)`.
2. In the callback: `repay(debt, type(uint256).max)`, withdraw `oracleConvert(debt → collateral, owed) × (1 + slippage)`
   of collateral (capped at the balance), `exactOutputSingle` collateral → exactly `flashAmount + premium` of debt,
   approve the Pool.
3. Withdraw all remaining collateral, send it (and any debt-asset dust) to the owner, emit `LoopClosed(returnedCollateral)`.

### Callback hardening

`executeOperation` requires `msg.sender == POOL`, `initiator == address(this)`, **and** a transient-storage
flag (`bool transient _flashActive`, EIP-1153) that is only set while our own `openLoop`/`closeLoop` is on
the stack. It dispatches on an encoded action byte (`1 = OPEN`, `2 = CLOSE`).

Transient storage requires **solc ≥ 0.8.28** (pinned in `foundry.toml`, `evm_version = "cancun"`) and a
chain with EIP-1153 (Arbitrum since ArbOS 20 "Atlas"). The fork tests run in revm, so they do not by
themselves prove the Arbitrum node accepts `TSTORE`; that is a documented chain-version dependency.

## Design decisions

- **Per-user account instead of credit delegation.** With credit delegation a shared bot contract would
  borrow on the user's behalf, which needs the user to sign a delegation to a contract that also serves
  other users, and the user's own EOA position would carry the risk. A per-user account is its own Aave
  borrower: positions are isolated, the owner is the only one who can move funds, the whole state is
  readable with one `getUserAccountData(account)` call, and nothing ever needs an allowance over the
  user's other funds beyond the principal they approve.
- **Flash loan instead of iterative looping.** A naive supply→borrow→swap loop needs ~log(1/(1−LTV))
  iterations at high leverage, pays swap fees on each, and is non-atomic. One `flashLoanSimple` of
  `principal × (L − 1)` gets to the exact target in one swap; the extra cost is Aave's flash premium
  (5 bps on Arbitrum at the pinned block). Unwinding the same way needs no free capital.
- **`flashLoanSimple`, not `flashLoan` with mode 2.** Opening a debt position straight from the flash loan
  would save the premium, but the simple variant keeps repay/borrow explicit and readable, and its
  premium is small at these sizes.
- **Slippage is anchored to the Aave oracle**, not to a spot quote passed in by the bot. The oracle is
  what Aave uses for the health factor, so "value received ≥ oracle value − slippage" is the right
  invariant, and it cannot be manipulated by moving the Uniswap pool in the same block. The bot can
  still tighten `maxSlippageBps` from an off-chain QuoterV2 quote. A hard cap of 5% (`MAX_SLIPPAGE_BPS`)
  guards against fat-fingered params.
- **`exactOutputSingle` on close** so we sell exactly the collateral needed to repay the flash loan and
  nothing more; everything else is returned in the collateral asset.
- **Post-trade health-factor check** (`minHealthFactor`) is in addition to Aave's own LTV check, so the
  bot can demand a safety buffer above liquidation.
- **Uniswap fee tier 100 (0.01%)** for WETH/wstETH. At the pinned block the fee-100 pool held
  pool token balances of ~380 WETH / ~21.5 wstETH; fee 500 and 3000 pools held < 1 ETH. Quotes through the
  fee-100 pool were flat (≤ ~0.01% from the oracle) up to ~16 wstETH out. **This caps practical
  position size per transaction** (a 3x open on P buys 2P), which is why the tests use a 5 wstETH
  principal. Larger positions would need a different route (e.g. an aggregator) or several opens.
- **No OpenZeppelin, no upgradeability** in `CarryAccount`. Immutable owner/pool/oracle/router; minimal local interfaces. (`CarryVault` uses OpenZeppelin v5.4.0, vendored in `lib/openzeppelin-contracts` with only `contracts/` kept.)

## Not covered (on purpose)

- **No onchain automation.** Rebalancing, deleveraging when HF drops, or closing when the spread
  inverts is keeper-driven by the TS bot calling `openLoop` / `closeLoop` as the owner.
- **No partial deleverage function.** Only full close; resizing = close + open (or an additional open).
- **No multi-hop routing / aggregators.** Single Uniswap v3 pool per pair.
- **Ownership is not transferable**, there is no guardian/pause, and the owner must be the EOA (or
  smart wallet) that the bot signs with.
- **Not audited.** Hackathon code.

## Verified Arbitrum One addresses

| | Address |
| --- | --- |
| Aave v3 Pool (rev 11) | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| Aave Oracle | `0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7` |
| Uniswap SwapRouter02 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` |
| WETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` (variable debt `0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351`) |
| wstETH | `0x5979D7b546E38E414F7E9822514be443A4800529` (aToken `0x513c7E3a9c69cA3e22550eF58AC1C0088e918FFf`) |
| Uniswap WETH/wstETH 0.01% pool | `0x35218a1cbaC5Bbc3E57fd9Bd38219D37571b3537` |

## Running

```bash
cd contracts
forge build
forge test -vv                      # fork tests, pinned to block 510331109
forge test -vv --gas-report
ARB_FORK_BLOCK=0 forge test         # fork at latest block instead
ARB_RPC_URL=https://arbitrum-one-rpc.publicnode.com forge test   # alternate RPC
```

Env vars: `ARB_RPC_URL` (default `https://arb1.arbitrum.io/rpc`), `ARB_FORK_BLOCK` (default `510331109`,
`0` = latest). Pinning the block lets Foundry cache RPC state, so reruns take ~1s instead of ~85s and
don't trip public-RPC rate limits.

## Test results

Final run (`forge test -vv --gas-report`, fork at Arbitrum block 510331109; the suite also passes at latest):

```
Ran 10 tests for test/CarryAccount.t.sol:CarryAccountForkTest
[PASS] test_carry_30days_logOnly() (gas: 1220496)
Logs:
  equity t0 (USD 1e8): 1670295288706
  equity t30 (USD 1e8): 1664526090517
  equity change (USD 1e8, excl. staking yield): -5769198189
  HF after 30 days: 1436558076777479575

[PASS] test_closeLoop_returnsMostPrincipal() (gas: 1663685)
Logs:
  principal wstETH: 5000000000000000000
  returned  wstETH: 4987996435729854675
  round-trip cost (bps of principal): 24

[PASS] test_executeOperation_rejectsForeignCaller() (gas: 89713)
[PASS] test_factory_recordsAccount() (gas: 52296)
[PASS] test_onlyOwner() (gas: 81649)
[PASS] test_openLoop_3x() (gas: 1275991)
Logs:
  after openLoop 3x
    collateral (USD 1e8): 5017622147873
    debt       (USD 1e8): 3347326859167
    healthFactor (1e18):  1439034030622511524
    leverage     (1e18):  3004032988538343233

[PASS] test_openLoop_revertsIfHealthTooLow_30x() (gas: 871189)
[PASS] test_openLoop_revertsIfHealthTooLow_minHf() (gas: 1073483)
[PASS] test_openLoop_revertsOnExcessiveSlippage() (gas: 3673706)
[PASS] test_rescue() (gas: 331934)
Suite result: ok. 10 passed; 0 failed; 0 skipped

| CarryAccount function | Min    | Median    | Max       |
| closeLoop             | 22407  | 389369    | 756331    |
| openLoop              | 23125  | 1079808   | 3662092   |
| CarryAccountFactory.createAccount | 23728 | 2003498 | 2003498 |
```

(The `openLoop` max is the reverting slippage test; a successful 3x open is ~1.08M gas and a full close ~756k gas.)

What the numbers say:

- **3x open**: leverage 3.004x, HF 1.439 (theory: 0.96 × 3 / 2 = 1.44), in e-mode 7, nothing left idle.
- **Round trip** (open 3x then close in the same block) returns 4.988 of 5 wstETH: **24 bps** cost =
  two flash premiums (5 bps on ~2P each) + two 1 bp swaps + oracle/market price gap.
- **30-day warp**: equity falls ~$57.7 on ~$16.7k because a warp accrues WETH borrow interest but does
  not move wstETH's exchange rate, i.e. this is the cost leg only (≈ 2.1% APR on ~$33.5k debt). In
  reality staking yield on ~$50k collateral (~$115/month at 2.8%) outweighs it.

What each test covers:

| Test | Checks |
| --- | --- |
| `test_openLoop_3x` | leverage within ±5% of 3x, HF ≥ 1.05 and ≥ `minHealthFactor`, debt > 0, e-mode 7, principal pulled, no idle balances |
| `test_closeLoop_returnsMostPrincipal` | owner gets ≥ 99% of principal back, Aave debt and collateral are 0 |
| `test_onlyOwner` | stranger cannot `openLoop` / `closeLoop` / `rescue` |
| `test_executeOperation_rejectsForeignCaller` | direct call reverts `NotPool`; Pool with foreign initiator reverts `BadInitiator`; Pool outside our flash reverts `NoActiveFlashLoan` |
| `test_openLoop_revertsIfHealthTooLow_minHf` | 3x with `minHealthFactor = 2.0` reverts `HealthFactorTooLow` (our check) |
| `test_openLoop_revertsIfHealthTooLow_30x` | 30x on 0.1 wstETH reverts in Aave's borrow with `HealthFactorLowerThanLiquidationThreshold()` |
| `test_openLoop_revertsOnExcessiveSlippage` | 30x on 5 wstETH would buy ~145 wstETH from a ~21.5 wstETH pool → `Too little received` |
| `test_factory_recordsAccount` | factory records the account, one per owner |
| `test_rescue` | owner can pull stray tokens |
| `test_carry_30days_logOnly` | informational, logs equity change over 30 days |

---

# CarryVault

`src/CarryVault.sol` is the managed-vault product from `BUSINESS.md`: an ERC-4626 vault over a stablecoin
(Paxos **USDG on Robinhood Chain** first, the same code for USDC or USDG on Arbitrum One). Users deposit;
the Carry bot (`operator`) moves capital into allowlisted strategy contracts and marks their value; the
vault charges **10% of gains above a high-water mark and no management fee**. Built on OpenZeppelin v5.4.0
(`ERC4626`, `Ownable2Step`, `Pausable`, `ReentrancyGuard`, `SafeERC20`).

## Design

| Piece | How it works |
| --- | --- |
| Roles | `owner` (Ownable2Step: transfer + accept) configures everything. `operator` (the bot) can only call `operatorCall`, `approveTarget`, `reportDeployed`. |
| Accounting | `totalAssets() = idleAssets() + deployedAssets`. Idle is the vault's own asset balance. |
| Principal flows | `operatorCall(target, data, value)` measures the vault's asset balance before and after the call and books the difference to `deployedAssets` (out → deployed, back → returned). Moving money into a strategy never changes the share price. |
| PnL marks | `reportDeployed(x)` may move `deployedAssets` by at most `maxReportChangeBps` (default 2%, owner max 10%) of its current value, and at most once per `minReportInterval` (default 1 h). A per-call bound alone could be defeated by calling it 50 times in one block; the interval makes it a per-window bound. |
| Owner reconcile | `syncDeployed(x)` (owner only, unbounded) for flows that land outside `operatorCall`, e.g. an asynchronous bridge delivery. |
| Operator limits | Target must be allowlisted by the owner. The asset token and the vault itself can never be a target (`allowTarget` and `operatorCall` both reject them), so the operator cannot `transfer`/`transferFrom`/`approve` vault funds directly. Allowances go through `approveTarget(token, spender, amount)`, which requires an allowlisted spender. `nonReentrant` and `whenNotPaused`. Reverts bubble up. |
| Deposit cap | `depositCap` (owner-set) bounds `totalAssets()` after a deposit; above it `DepositCapExceeded`. `maxDeposit` reports the room left (0 while paused). |
| Pause | `pause()` blocks deposits, mints and every operator action. **Withdrawals and redeems are never paused.** |
| Withdrawals | Standard ERC-4626, served only from idle assets. If idle is short, `withdraw`/`redeem` revert with `InsufficientIdleAssets(needed, idle)`; the operator must unwind first. `maxWithdraw`/`maxRedeem` are capped by idle so they stay honest per EIP-4626. |
| Inflation attack | OZ virtual shares with `_decimalsOffset() = 6` (shares have 12 decimals for a 6-decimal asset). |

## Fee math

Price per share, 1e18-scaled, normalised so a fresh vault reads exactly `1e18` (one asset per whole share):

```
v   = 10^6                                    (virtual shares)
pps = (totalAssets + 1) × 1e18 × v / (supply + v)
```

When `pps > highWaterMark`:

```
gain      G = (totalAssets + 1) × (pps − hwm) / pps          (assets above the mark)
fee       F = G × performanceFeeBps / 10_000
feeShares s = F × (supply + v) / (totalAssets + 1 − F)       (so the s shares are worth exactly F after minting)
hwm         = pps after minting
```

Example from the tests: 1,000 USDG deposited, +100 USDG gain → fee = 10 USDG (1% of starting TVL), the
depositor keeps 1,090, HWM moves to 1.09. A second `harvest()` with no new gain mints nothing. After a loss
nothing is charged until the price is back above the old mark, and then only on the part above it.

- `harvest()` is permissionless. The fee is also accrued before every `deposit`/`mint`/`withdraw`/`redeem`
  and before `setPerformanceFee`/`setFeeRecipient`.
- `convertTo*`/`preview*` include pending fee shares, so previews equal execution and a late depositor is
  never charged for gains made before they entered (tested).
- If the supply is 0, the mark is reset to the current price instead of charging anyone.
- `performanceFeeBps` default 1000 (10%), owner may set 0–2000.

## Threat model

| Actor | Can | Cannot |
| --- | --- | --- |
| Depositor | Deposit under the cap, withdraw idle assets at any time, even while paused. | Enter or exit at a pre-fee price; profit from a first-deposit donation. |
| Operator (bot key) | Call allowlisted targets with vault funds; approve allowlisted spenders; mark PnL within ±2% per hour. | Call the asset token or the vault; approve a non-allowlisted spender; add targets; change fees, cap or roles; act while paused. |
| Owner | Everything above plus allowlist, pause, fees (≤20%), cap, report bounds, `syncDeployed`. | Pause withdrawals of idle assets; mint shares other than through the fee. |

Residual risks, stated plainly:

- **The allowlist is the security boundary.** An allowlisted target that can send vault funds anywhere
  (e.g. a generic router with an arbitrary recipient) lets a compromised operator drain what it approves.
  Only allowlist strategy contracts that return funds to the vault.
- **Operator marks are trusted within the bound.** A compromised operator can inflate `deployedAssets` by
  up to 2% per hour and harvest 10% of that (≈ 0.2% of strategy TVL per hour) until the owner pauses.
- **Owner is trusted.** `syncDeployed` is unbounded, and the owner chooses the allowlist. Use a multisig.
- **Strategies must pull inside `operatorCall`.** A pull at any other time looks like a loss until reconciled.
- **Deployed capital is not instantly withdrawable.** Exits depend on the operator unwinding.

## Not covered

- No onchain strategy adapters yet: the vault is the custody and accounting layer; strategies are
  allowlisted contracts called through `operatorCall`. No withdrawal queue.
- No timelock on owner actions, no guardian role separate from the owner.
- `receive()` exists so `operatorCall` can forward `value`, but there is no rescue function for stray ETH
  or non-asset tokens; the only way out is an `operatorCall` to an allowlisted target. Deliberate: a
  generic rescue would be another path for vault funds to leave.
- Fork-tested on the real USDG for deposit/withdraw only; operator flows are tested with a mock strategy.
- Not audited (the business plan puts an audit before outside deposits).

## Verified Robinhood Chain facts (2026-10-04)

RPC `https://rpc.mainnet.chain.robinhood.com` answers, `cast chain-id` = **4663**, gas price ≈ 0.022 gwei.

**Canonical Paxos USDG = `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`.**

| | `0x5fc5360D…1d168` | `0x0A3B763d…3954F` |
| --- | --- | --- |
| `name()` / `symbol()` | "Global Dollar" / USDG (same name Paxos uses on Ethereum and Arbitrum) | "Paxos USDG" / USDG |
| `decimals()` | 6 | 6 |
| `totalSupply()` | 699,761,516 USDG | 1,100 USDG |
| Proxy (EIP-1967 impl slot) | yes → impl `0x68184c44…66f8f`, UUPS; `owner()` `0xcFA0…4C6F`; `paused()` false | yes → impl `0x3a501325…863a0`, UUPS; `owner()` `0xf7e3…1F6C` |
| Listed by Paxos docs (docs.paxos.com/guides/stablecoin/usdg/mainnet, "Robinhood Mainnet") | **yes** (supply control `0xdf5F…25D4`, OFT `0x0d54…28d1`) | no |
| Listed by docs.robinhood.com/chain/contracts | **yes** | no |

The second token is a small unofficial deployment with a look-alike name; do not use it.
Paxos USDG on Arbitrum One is `0x004B506865409877C9fA29bfb1ebA929984B9bbC` ("Global Dollar", 6 decimals, checked with `cast`).

Testnets (addresses from docs.paxos.com/guides/stablecoin/usdg/testnet, each checked with `cast`):

| Chain | RPC check | Paxos testnet USDG |
| --- | --- | --- |
| Robinhood Chain testnet | `https://rpc.testnet.chain.robinhood.com/rpc`, chain id **46630** | `0x7E955252E15c84f5768B83c41a71F9eba181802F`: "Global Dollar", USDG, 6 dec, supply 57.3M, EIP-1967 proxy; testnet Blockscout API (`explorer.testnet.chain.robinhood.com/api`) answers and reports 4,109 holders |
| Arbitrum Sepolia | chain id **421614** | `0xFFC95faa3d63Cde504a05B567C600B78C0b41892`: "Global Dollar", USDG, 6 dec, supply 2.1M |

On Robinhood testnet, mainnet USDG `0x5fc5…` has no code; `0x0A3B…` has a proxy but its calls revert. Arbitrum Sepolia
Aave v3: Pool `0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff` → `ADDRESSES_PROVIDER()` `0xB25a5D144626a0D488e52AE717A051a2E9997076`
→ `getPriceOracle()` `0xEf95A6B9e88Bd509Fd67BA741cf2b263DaC65c00` (and `getPool()` returns the same Pool). Uniswap SwapRouter02
`0x101F443B4d1b059569D643917553c771E1b9663E` has code (`factory()` `0x248A…188e`, `WETH9()` `0x980B…7c73`).

Explorers: `explorer.chain.robinhood.com` failed the TLS handshake from here; Robinhood's docs link to
Blockscout at `robinhoodchain.blockscout.com` (behind a Cloudflare challenge, so its `/api` could not be
probed with curl), and Etherscan v2 lists chain 4663 as `robin.etherscan.io` (checked via
`api.etherscan.io/v2/chainlist`). `foundry.toml` configures Etherscan v2 for 42161/421614/4663.

## Vault tests

```bash
forge test --match-path test/CarryVault.t.sol -vv
SKIP_ROBINHOOD_FORK=true forge test     # skip the Robinhood fork if its public RPC is down
```

The Robinhood fork test forks at the latest block by default (`ROBINHOOD_FORK_BLOCK`, `ROBINHOOD_RPC_URL`):
the public RPC is not an archive node and rejects older blocks with "historical state … is not available".
It funds a user from a large USDG holder via `vm.prank`, deposits 1,000 USDG, withdraws 250, redeems the rest
and checks the user gets exactly 1,000 back.

| Test | Checks |
| --- | --- |
| `test_initialState` | 12-decimal shares, pps = HWM = 1e18, defaults |
| `test_depositWithdraw_roundTrip` | 1:1 shares, withdraw + redeem return everything |
| `test_previewsMatchExecution_withPendingFee` | `previewDeposit`/`previewRedeem` equal execution while a fee is pending |
| `test_depositCap` | `DepositCapExceeded`, `maxDeposit` = room left |
| `test_pauseBlocksDepositButNotWithdraw` | paused: deposit/mint/operator actions revert, withdraw/redeem work |
| `test_operatorCall_onlyAllowlisted_neverAsset` | non-allowlisted target, asset token and vault itself all rejected |
| `test_operatorCall_tracksPrincipal_ppsUnchanged` | out/back flows tracked, pps unchanged, `InsufficientIdleAssets` until unwound |
| `test_operatorCall_bubblesRevert` | target reverts propagate |
| `test_approveTarget_onlyAllowlistedSpender` | approvals only to allowlisted spenders |
| `test_reportDeployed_bounded_andRateLimited` | ±2% bound, 1 h interval, owner `syncDeployed` |
| `test_harvest_feeMath_10pctGain` | 10% gain → fee worth 10 USDG (1% of TVL), HWM = 1.09, no second fee |
| `test_harvest_noFeeAfterLossUntilRecovered` | HWM never moves down; fee only above the old mark |
| `test_harvest_onDeposit_lateDepositorNotCharged` | fee accrued before a new deposit |
| `test_setPerformanceFee_bounds_andAccruesFirst` | > 20% rejected; old rate applied to existing gain |
| `test_inflationAttack_firstDepositorDonation` | 1-wei deposit + 100k donation: victim loses < 0.1%, attacker gets back less than they put in |
| `test_onlyOwnerAndOperatorGuards` | every owner/operator function guarded, two-step ownership, zero-address checks |
| `test_fork_robinhood_usdg_depositWithdraw` | real USDG on a Robinhood Chain fork |

Full suite (`forge test`, 2026-10-04):

```
Ran 16 tests for test/CarryVault.t.sol:CarryVaultTest
Suite result: ok. 16 passed; 0 failed; 0 skipped
Ran 10 tests for test/CarryAccount.t.sol:CarryAccountForkTest
Suite result: ok. 10 passed; 0 failed; 0 skipped
Ran 1 test for test/CarryVault.t.sol:CarryVaultRobinhoodForkTest
Suite result: ok. 1 passed; 0 failed; 0 skipped
Ran 3 test suites in 8.60s (9.67s CPU time): 27 tests passed, 0 failed, 0 skipped (27 total tests)
```

## Deploy dry runs (simulated, not broadcast)

Sender `0x…C0FFEE01` (empty) unless noted. Addresses depend on the deployer's nonce; a real deploy will give different ones.

| Script | Chain (gas price read) | Gas | ETH | Result |
| --- | --- | --- | --- | --- |
| `DeployRobinhoodTestnet` | Robinhood testnet 46630 (0.01 gwei) | 3,905,408 | 0.000078 | vault over real testnet USDG; seed skipped (empty sender) |
| `DeployRobinhoodTestnet`, sender = a real testnet USDG holder (`0x545F…b983`) | same | 4,028,032 | 0.000081 | vault + 1 USDG seed deposit, supply 1e12 shares |
| `DeployRobinhoodTestnet`, `USE_MOCK_USDG=true` | same | 4,738,688 | 0.000095 | MockUSDG + vault + 1 mUSDG seed deposit |
| `DeployArbitrum` | Arbitrum Sepolia 421614 (0.05 gwei) | 3,213,057 | 0.000321 | factory wired to Sepolia Aave Pool/oracle + SwapRouter02 |
| `DeployArbitrumVault` | Arbitrum Sepolia (0.05 gwei) | 3,714,557 | 0.000376 | vault over Sepolia testnet USDG |
| `DeployRobinhoodTestnet`, sender = project deployer `0x8c83…20Fa` (nonce 54, 0 USDG) | Robinhood testnet | 3,906,730 | 0.000078 | CarryVault `0x330677cDA0fc0C7a184A3a150fb08De973A9C4F1` |
| same, `USE_MOCK_USDG=true` | Robinhood testnet | 4,740,267 | 0.000095 | MockUSDG `0x3306…C4F1`, CarryVault `0x172B6169285eE59CD24D1669517513c75A28236A`, 1 mUSDG seeded |
| `DeployArbitrum`, sender = `0x8c83…20Fa` (nonce 0) | Arbitrum Sepolia | 3,211,588 | 0.000327 | CarryAccountFactory `0x71da6a936f1196881C236c62a084ddEB448772Ba` |
| `DeployArbitrum` | Arbitrum One 42161 (0.02 gwei) | 3,146,945 | 0.000126 | factory, mainnet addresses |
| `DeployRobinhoodVault` | Robinhood Chain 4663 (0.022 gwei) | 3,592,945 | 0.000160 | vault over USDG `0x5fc5…` |
| `DeployArbitrumVault` | Arbitrum One (0.02 gwei) | 3,615,470 | 0.000145 | USDC vault |

Commands: [`../DEPLOY.md`](../DEPLOY.md).
