# Verification record

Every address and unit this bot depends on was checked against Arbitrum One with read-only calls on 2026-09-30, before any code used it.

## Units

| Quantity | Check | Result |
| --- | --- | --- |
| GMX `/markets/info` funding and borrowing rates | ETH/USD [ETH-USDC] `fundingRateLong` / 1e30 / 31,536,000 against DataStore `SAVED_FUNDING_FACTOR_PER_SECOND` for the same market (key = keccak(abi.encode(keccak(abi.encode("SAVED_FUNDING_FACTOR_PER_SECOND")), market))) | 1.1706e-9 vs 1.1708e-9 per second. API rates are **annualized fractions at 1e30 scale**. |
| GMX sign convention | BTC/USD: `netRateShort` = `fundingRateShort` + `borrowingRateShort` (−0.026 + 0.0397 = 0.0137) | Positive = that side **pays**. Carry = −netRate. |
| Aave v3 rates | `currentLiquidityRate` for USDC = 3.06e25 | Ray (1e27) linear APR; compounded per second to APY. |
| Compound v3 rates | cUSDCv3 `getSupplyRate(getUtilization())` = 963,127,730 | Per-second, 1e18 scale → 3.08% APY. |
| Hyperliquid `predictedFundings` | ETH `fundingIntervalHours` 1 (HL), 4/8 (Binance, Bybit) | Rate per interval; annualized × 8760/h. |

## Addresses

| Contract | Address | Check |
| --- | --- | --- |
| Aave v3 Pool | 0x794a61358D6845594F94dc1DB02A252b5b4814aD | `POOL_REVISION()` = 11; `getReservesList()` returns USDC, WETH, wstETH… |
| Aave PoolAddressesProvider | 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb | `getPriceOracle()` → 0xb56c…C7C7, `getPoolDataProvider()` → 0x243A…c43b |
| Aave e-mode 7 | "wstETH/WETH ETH Correlated" | LTV 94%, LT 96%; collateral bitmap = wstETH (id 8), borrowable = WETH (id 4) |
| Compound cUSDCv3 | 0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf | `baseToken()` = native USDC |
| Compound cUSDC.ev3 | 0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA | `baseToken()` = USDC.e |
| Compound cUSDTv3 | 0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07 | `baseToken()` = USDT0 |
| Compound cWETHv3 | 0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486 | `baseToken()` = WETH |
| Uniswap v3 SwapRouter02 | 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 | `factory()` = 0x1F98…F984 |
| Uniswap v3 QuoterV2 | 0x61fFE014bA17989E743c5F6cB21bF9697530B21e | `factory()` = 0x1F98…F984 |
| WETH/wstETH 0.01% pool | 0x35218a1cbaC5Bbc3E57fd9Bd38219D37571b3537 | `getPool(WETH, wstETH, 100)` |
| GMX v2.2 ExchangeRouter / Reader / DataStore / OrderVault / Router | see `src/config.ts` | Order created on a fork; pending key readable from DataStore `ACCOUNT_ORDER_LIST` |

## GMX execution fee

A fixed 0.0006 ETH fee reverted on the fork with `InsufficientExecutionFee(4177115511238881, 600000000000000)` at a 1.0115 gwei gas price, so GMX charges about 4.13M gas-equivalents for an increase order. The executor now sizes the fee as `gasPrice × 4.2M × 1.3` (keepers refund the excess). On Arbitrum mainnet at 0.01 gwei that is about 0.00005 ETH.
