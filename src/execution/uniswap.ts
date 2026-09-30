import { concat, encodeFunctionData, numberToHex, type PublicClient } from "viem";
import { uniswapFactoryAbi, uniswapPoolAbi, uniswapQuoterAbi, uniswapRouterAbi } from "../abis.ts";
import { TOKENS, UNISWAP } from "../config.ts";
import type { Address, Hex } from "../types.ts";

const FEES = [100, 500, 3000, 10000] as const;
const ZERO = "0x0000000000000000000000000000000000000000";

export const encodePath = (tokens: Address[], fees: number[]): Hex =>
  concat(tokens.flatMap((t, i) => (i < fees.length ? [t, numberToHex(fees[i]!, { size: 3 })] : [t]))) as Hex;

const pools = new Map<string, boolean>();
const hasPool = async (client: PublicClient, a: Address, b: Address, fee: number): Promise<boolean> => {
  const k = `${a}${b}${fee}`.toLowerCase();
  if (pools.has(k)) return pools.get(k)!;
  const pool = await client.readContract({ address: UNISWAP.FACTORY, abi: uniswapFactoryAbi, functionName: "getPool", args: [a, b, fee] });
  let ok = pool !== ZERO;
  if (ok) ok = (await client.readContract({ address: pool, abi: uniswapPoolAbi, functionName: "liquidity" })) > 0n;
  pools.set(k, ok);
  return ok;
};

export interface Route { path: Hex; tokens: Address[]; fees: number[]; amountOut: bigint }

/**
 * Best Uniswap v3 route for an exact-input swap: every live direct pool plus two-hop routes through
 * WETH and USDC, each priced with QuoterV2 (an eth_call, nothing is sent).
 */
export const bestRoute = async (client: PublicClient, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Route> => {
  const cands: { tokens: Address[]; fees: number[] }[] = [];
  for (const f of FEES) if (await hasPool(client, tokenIn, tokenOut, f)) cands.push({ tokens: [tokenIn, tokenOut], fees: [f] });
  for (const mid of [TOKENS.WETH, TOKENS.USDC] as Address[]) {
    if (mid.toLowerCase() === tokenIn.toLowerCase() || mid.toLowerCase() === tokenOut.toLowerCase()) continue;
    for (const f1 of FEES) {
      if (!(await hasPool(client, tokenIn, mid, f1))) continue;
      for (const f2 of FEES) if (await hasPool(client, mid, tokenOut, f2)) cands.push({ tokens: [tokenIn, mid, tokenOut], fees: [f1, f2] });
    }
  }
  if (!cands.length) throw new Error(`no Uniswap v3 route ${tokenIn} → ${tokenOut}`);
  const quoted = await Promise.all(cands.map(async (c) => {
    const path = encodePath(c.tokens, c.fees);
    try {
      const { result } = await client.simulateContract({ address: UNISWAP.QUOTER_V2, abi: uniswapQuoterAbi, functionName: "quoteExactInput", args: [path, amountIn] });
      return { ...c, path, amountOut: result[0] };
    } catch {
      return { ...c, path, amountOut: 0n };
    }
  }));
  const best = quoted.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0))[0]!;
  if (best.amountOut === 0n) throw new Error(`all Uniswap quotes failed ${tokenIn} → ${tokenOut}`);
  return best;
};

export const exactInputData = (route: Route, recipient: Address, amountIn: bigint, slippageBps: number): { data: Hex; minOut: bigint } => {
  const minOut = (route.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  return { minOut, data: encodeFunctionData({ abi: uniswapRouterAbi, functionName: "exactInput", args: [{ path: route.path, recipient, amountIn, amountOutMinimum: minOut }] }) };
};
