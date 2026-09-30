import { parseUnits, type PublicClient } from "viem";
import { uniswapQuoterAbi } from "../abis.ts";
import { TOKENS, UNISWAP } from "../config.ts";
import { bestRoute } from "../execution/uniswap.ts";
import type { Address } from "../types.ts";

const DEC: Record<string, number> = { USDC: 6, USDT: 6, WBTC: 8 };
const PAIRS: [string, string][] = [
  ["USDC", "WETH"], ["USDC", "WBTC"], ["USDC", "ARB"], ["USDC", "LINK"], ["USDC", "GMX"],
  ["WETH", "wstETH"], ["WETH", "weETH"], ["USDC", "USDT"], ["WETH", "WBTC"],
];
const SIZES = [10_000, 50_000, 250_000, 1_000_000, 5_000_000];

export const pairKey = (a: string, b: string) => [a === "ETH" ? "WETH" : a, b === "ETH" ? "WETH" : b].sort().join("/");

/**
 * How much USD each Uniswap v3 pair absorbs before 1% price impact, measured with QuoterV2 on the
 * best route at increasing sizes. Carry is worthless if the hedge cannot be put on, so strategy
 * capacity is capped by the swap legs as well as by lending and perp liquidity.
 */
export const readDexDepth = async (client: PublicClient, prices: Record<string, number>, maxImpact = 0.01): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  await Promise.all(PAIRS.map(async ([a, b]) => {
    const pa = prices[a] ?? prices[a === "WETH" ? "ETH" : a];
    if (!pa) return;
    const tIn = (TOKENS as Record<string, Address>)[a]!;
    const tOut = (TOKENS as Record<string, Address>)[b]!;
    const amt = (usd: number) => parseUnits((usd / pa).toFixed(DEC[a] ?? 12), DEC[a] ?? 18);
    try {
      const base = await bestRoute(client, tIn, tOut, amt(1_000));
      const rate0 = Number(base.amountOut) / 1_000;
      let depth = 1_000;
      for (const usd of SIZES) {
        const { result } = await client.simulateContract({ address: UNISWAP.QUOTER_V2, abi: uniswapQuoterAbi, functionName: "quoteExactInput", args: [base.path, amt(usd)] });
        const impact = 1 - Number(result[0]) / usd / rate0;
        if (impact > maxImpact) break;
        depth = usd;
      }
      out[pairKey(a, b)] = depth;
    } catch {
      /* unknown pair depth: no cap applied */
    }
  }));
  return out;
};
