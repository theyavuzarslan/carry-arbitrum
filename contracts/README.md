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
- **No OpenZeppelin, no upgradeability.** Immutable owner/pool/oracle/router; minimal local interfaces.

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
