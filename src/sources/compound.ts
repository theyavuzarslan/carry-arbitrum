import type { PublicClient } from "viem";
import { formatUnits } from "viem";
import { cometAbi, erc20Abi } from "../abis.ts";
import { COMPOUND, SECONDS_PER_YEAR } from "../config.ts";
import { canonicalSymbol } from "../tokens.ts";
import type { Address, LendingMarket } from "../types.ts";

/** Comet rates are per-second 1e18 fixed point. */
const perSecondToApy = (r: bigint): number => (1 + Number(r) / 1e18) ** SECONDS_PER_YEAR - 1;

/**
 * Compound v3 on Arbitrum. Each Comet has one borrowable base asset and several collateral assets
 * that earn nothing. We emit one market row for the base asset and one per collateral asset.
 */
export const readCompoundMarkets = async (client: PublicClient): Promise<LendingMarket[]> => {
  const out: LendingMarket[] = [];
  await Promise.all(Object.values(COMPOUND).map(async ({ comet }) => {
    const [base, util, totalSupply, totalBorrow, decimals, numAssets, baseFeed] = await Promise.all([
      client.readContract({ address: comet, abi: cometAbi, functionName: "baseToken" }),
      client.readContract({ address: comet, abi: cometAbi, functionName: "getUtilization" }),
      client.readContract({ address: comet, abi: cometAbi, functionName: "totalSupply" }),
      client.readContract({ address: comet, abi: cometAbi, functionName: "totalBorrow" }),
      client.readContract({ address: comet, abi: cometAbi, functionName: "decimals" }),
      client.readContract({ address: comet, abi: cometAbi, functionName: "numAssets" }),
      client.readContract({ address: comet, abi: cometAbi, functionName: "baseTokenPriceFeed" }),
    ]);
    const [supplyRate, borrowRate, basePrice8, baseSym] = await Promise.all([
      client.readContract({ address: comet, abi: cometAbi, functionName: "getSupplyRate", args: [util] }),
      client.readContract({ address: comet, abi: cometAbi, functionName: "getBorrowRate", args: [util] }),
      client.readContract({ address: comet, abi: cometAbi, functionName: "getPrice", args: [baseFeed] }),
      client.readContract({ address: base, abi: erc20Abi, functionName: "symbol" }),
    ]);
    const basePrice = Number(basePrice8) / 1e8;
    const supUsd = Number(formatUnits(totalSupply, decimals)) * basePrice;
    const borUsd = Number(formatUnits(totalBorrow, decimals)) * basePrice;
    const baseSymbol = canonicalSymbol(base, baseSym);
    out.push({
      venue: "compound-v3", symbol: baseSymbol, asset: base, decimals, priceUsd: basePrice,
      supplyApr: perSecondToApy(supplyRate), borrowApr: perSecondToApy(borrowRate),
      totalSupplyUsd: supUsd, totalBorrowUsd: borUsd, availableUsd: Math.max(0, supUsd - borUsd),
      ltv: 0, liqThreshold: 0, canCollateral: false, canBorrow: true, executable: true, source: "onchain",
      comet, cometBase: baseSymbol,
    });
    const infos = await Promise.all(Array.from({ length: numAssets }, (_, i) =>
      client.readContract({ address: comet, abi: cometAbi, functionName: "getAssetInfo", args: [i] })));
    await Promise.all(infos.map(async (info) => {
      const [sym, dec, price8, totals] = await Promise.all([
        client.readContract({ address: info.asset, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address: info.asset, abi: erc20Abi, functionName: "decimals" }),
        client.readContract({ address: comet, abi: cometAbi, functionName: "getPrice", args: [info.priceFeed] }),
        client.readContract({ address: comet, abi: cometAbi, functionName: "totalsCollateral", args: [info.asset] }),
      ]);
      // On the WETH comet every feed is priced in ETH; fixCometEthPrices converts to USD later.
      const px = Number(price8) / 1e8;
      const cap = Number(formatUnits(info.supplyCap, dec));
      const supplied = Number(formatUnits(totals[0], dec));
      out.push({
        venue: "compound-v3", symbol: canonicalSymbol(info.asset, sym), asset: info.asset as Address, decimals: Number(dec), priceUsd: px,
        supplyApr: 0, borrowApr: null,
        totalSupplyUsd: supplied * px, totalBorrowUsd: 0, availableUsd: Math.max(0, cap - supplied) * px,
        ltv: Number(info.borrowCollateralFactor) / 1e18, liqThreshold: Number(info.liquidateCollateralFactor) / 1e18,
        canCollateral: true, canBorrow: false, executable: true, source: "onchain",
        comet, cometBase: baseSymbol,
      });
    }));
  }));
  return out;
};

/**
 * The cWETHv3 feeds are priced in ETH (its base feed returns 1e8 = 1 WETH). Multiply every value on
 * that comet by the snapshot's ETH/USD price once it is known.
 */
export const fixCometEthPrices = (markets: LendingMarket[], ethUsd: number): void => {
  for (const m of markets) {
    if (m.venue !== "compound-v3" || m.cometBase !== "WETH" || !m.priceUsd) continue;
    m.priceUsd *= ethUsd;
    m.totalSupplyUsd *= ethUsd;
    m.totalBorrowUsd *= ethUsd;
    m.availableUsd *= ethUsd;
  }
};
