import type { PublicClient } from "viem";
import { formatUnits } from "viem";
import { aaveDataProviderAbi, aaveOracleAbi, aavePoolAbi, erc20Abi } from "../abis.ts";
import { AAVE } from "../config.ts";
import type { Address, LendingMarket } from "../types.ts";
import { canonicalSymbol } from "../tokens.ts";

const RAY = 1e27;
/** Aave rates are per-year linear rates in ray. Convert to a compounded APY (per-second compounding). */
export const rayToApy = (ray: bigint): number => {
  const apr = Number(ray) / RAY;
  return (1 + apr / 31_536_000) ** 31_536_000 - 1;
};

export interface AaveEMode { id: number; label: string; ltv: number; liqThreshold: number; collateralBitmap: bigint; borrowableBitmap: bigint }

/** Read every e-mode category (ids 1..maxId). Empty labels mean the id is unused. */
export const readEModes = async (client: PublicClient, maxId = 20): Promise<AaveEMode[]> => {
  const ids = Array.from({ length: maxId }, (_, i) => i + 1);
  const rows = await Promise.all(ids.map(async (id) => {
    try {
      const [label, cfg, coll, borr] = await Promise.all([
        client.readContract({ address: AAVE.POOL, abi: aavePoolAbi, functionName: "getEModeCategoryLabel", args: [id] }),
        client.readContract({ address: AAVE.POOL, abi: aavePoolAbi, functionName: "getEModeCategoryCollateralConfig", args: [id] }),
        client.readContract({ address: AAVE.POOL, abi: aavePoolAbi, functionName: "getEModeCategoryCollateralBitmap", args: [id] }),
        client.readContract({ address: AAVE.POOL, abi: aavePoolAbi, functionName: "getEModeCategoryBorrowableBitmap", args: [id] }),
      ]);
      if (!label || cfg.ltv === 0) return undefined;
      return { id, label, ltv: cfg.ltv / 1e4, liqThreshold: cfg.liquidationThreshold / 1e4, collateralBitmap: coll, borrowableBitmap: borr };
    } catch {
      return undefined;
    }
  }));
  return rows.filter((r): r is AaveEMode => !!r);
};

export interface AaveReserve extends LendingMarket {
  asset: Address;
  aToken: Address;
  variableDebtToken: Address;
  reserveId: number;
}

/** Every active Aave v3 reserve on Arbitrum with live rates, caps, prices and e-mode membership. */
export const readAaveMarkets = async (client: PublicClient): Promise<AaveReserve[]> => {
  const assets = await client.readContract({ address: AAVE.POOL, abi: aavePoolAbi, functionName: "getReservesList" });
  const [prices, unit, eModes] = await Promise.all([
    client.readContract({ address: AAVE.ORACLE, abi: aaveOracleAbi, functionName: "getAssetsPrices", args: [assets] }),
    client.readContract({ address: AAVE.ORACLE, abi: aaveOracleAbi, functionName: "BASE_CURRENCY_UNIT" }),
    readEModes(client),
  ]);
  const out = await Promise.all(assets.map(async (asset, i) => {
    const [symbol, cfg, data, caps, paused, pool] = await Promise.all([
      client.readContract({ address: asset, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address: AAVE.DATA_PROVIDER, abi: aaveDataProviderAbi, functionName: "getReserveConfigurationData", args: [asset] }),
      client.readContract({ address: AAVE.DATA_PROVIDER, abi: aaveDataProviderAbi, functionName: "getReserveData", args: [asset] }),
      client.readContract({ address: AAVE.DATA_PROVIDER, abi: aaveDataProviderAbi, functionName: "getReserveCaps", args: [asset] }),
      client.readContract({ address: AAVE.DATA_PROVIDER, abi: aaveDataProviderAbi, functionName: "getPaused", args: [asset] }),
      client.readContract({ address: AAVE.POOL, abi: aavePoolAbi, functionName: "getReserveData", args: [asset] }),
    ]);
    const [decimalsBn, ltvBps, liqBps, , , collEnabled, borrowEnabled, , isActive, isFrozen] = cfg;
    const decimals = Number(decimalsBn);
    const priceUsd = Number(prices[i]) / Number(unit);
    const [, , totalAToken, , totalVariableDebt, liquidityRate, variableBorrowRate] = data;
    const supplyUsd = Number(formatUnits(totalAToken, decimals)) * priceUsd;
    const borrowUsd = Number(formatUnits(totalVariableDebt, decimals)) * priceUsd;
    const [borrowCap, supplyCap] = caps;
    const borrowCapUsd = borrowCap > 0n ? Number(borrowCap) * priceUsd : Infinity;
    const supplyCapUsd = supplyCap > 0n ? Number(supplyCap) * priceUsd : Infinity;
    const liquidityUsd = Math.max(0, supplyUsd - borrowUsd);
    const usable = isActive && !isFrozen && !paused;
    const reserveId = Number(pool.id);
    const bit = 1n << BigInt(reserveId);
    const memberships = eModes
      .filter((e) => (e.collateralBitmap & bit) !== 0n || (e.borrowableBitmap & bit) !== 0n)
      .map((e) => ({ id: e.id, label: e.label, ltv: e.ltv, liqThreshold: e.liqThreshold, collateral: (e.collateralBitmap & bit) !== 0n, borrowable: (e.borrowableBitmap & bit) !== 0n }));
    const m: AaveReserve = {
      venue: "aave-v3",
      symbol: canonicalSymbol(asset, symbol),
      asset,
      decimals,
      priceUsd,
      supplyApr: rayToApy(liquidityRate),
      borrowApr: borrowEnabled ? rayToApy(variableBorrowRate) : null,
      totalSupplyUsd: supplyUsd,
      totalBorrowUsd: borrowUsd,
      // New borrows are limited by pool liquidity and the borrow cap; new supply by the supply cap.
      availableUsd: Math.max(0, Math.min(liquidityUsd, borrowCapUsd - borrowUsd)),
      ltv: Number(ltvBps) / 1e4,
      liqThreshold: Number(liqBps) / 1e4,
      canCollateral: usable && collEnabled && Number(ltvBps) > 0,
      canBorrow: usable && borrowEnabled,
      executable: usable,
      source: "onchain",
      eModes: memberships,
      aToken: pool.aTokenAddress,
      variableDebtToken: pool.variableDebtTokenAddress,
      reserveId,
    };
    // Keep the remaining supply headroom for sizing (NaN-safe).
    (m as AaveReserve & { supplyHeadroomUsd: number }).supplyHeadroomUsd = Math.max(0, supplyCapUsd - supplyUsd);
    return m;
  }));
  return out;
};
