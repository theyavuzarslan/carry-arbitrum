import { parseUnits, type PublicClient } from "viem";
import { TOKENS } from "../config.ts";
import { bestRoute } from "../execution/uniswap.ts";
import { getJson } from "../rpc.ts";
import type { Address } from "../types.ts";

/** One asset priced on two venues at the same moment, for a fixed trade size. */
export interface PriceLeg { venue: string; chainId: number; buyPx: number; sellPx: number; source: string }
export interface PricePair { asset: string; sizeUsd: number; a: PriceLeg; b: PriceLeg; asOf: string }

const DEC: Record<string, number> = { USDC: 6, WBTC: 8 };
const CEX_PAIRS: Record<string, string> = { WETH: "ETHUSDT", WBTC: "BTCUSDT", ARB: "ARBUSDT", LINK: "LINKUSDT", GMX: "GMXUSDT" };

/**
 * Uniswap v3 on Arbitrum One against Binance spot, at the same size. Uniswap prices are live QuoterV2
 * quotes in both directions (fees and impact included); Binance is best bid/ask converted from USDT
 * to USD with Binance's own USDC/USDT book.
 */
export const readCexDex = async (client: PublicClient, prices: Record<string, number>, sizeUsd = 10_000): Promise<PricePair[]> => {
  const symbols = Object.values(CEX_PAIRS).concat("USDCUSDT");
  const book = await getJson<{ symbol: string; bidPrice: string; askPrice: string }[]>(`https://api.binance.com/api/v3/ticker/bookTicker?symbols=${encodeURIComponent(JSON.stringify(symbols))}`);
  const by = new Map(book.map((b) => [b.symbol, b]));
  const usdcUsdt = by.get("USDCUSDT");
  const usdtPerUsd = usdcUsdt ? (Number(usdcUsdt.bidPrice) + Number(usdcUsdt.askPrice)) / 2 : 1;
  const out: PricePair[] = [];
  await Promise.all(Object.entries(CEX_PAIRS).map(async ([asset, pair]) => {
    const b = by.get(pair);
    const px = prices[asset] ?? prices[asset === "WETH" ? "ETH" : asset === "WBTC" ? "BTC" : asset];
    if (!b || !px) return;
    const tok = (TOKENS as Record<string, Address>)[asset]!;
    const dec = DEC[asset] ?? 18;
    try {
      const buy = await bestRoute(client, TOKENS.USDC, tok, parseUnits(sizeUsd.toFixed(6), 6));
      const sellIn = parseUnits((sizeUsd / px).toFixed(Math.min(dec, 12)), dec);
      const sell = await bestRoute(client, tok, TOKENS.USDC, sellIn);
      const buyPx = sizeUsd / (Number(buy.amountOut) / 10 ** dec);
      const sellPx = Number(sell.amountOut) / 1e6 / (Number(sellIn) / 10 ** dec);
      out.push({
        asset, sizeUsd, asOf: new Date().toISOString(),
        a: { venue: "uniswap-v3", chainId: 42161, buyPx, sellPx, source: "QuoterV2, fees and impact included" },
        b: { venue: "binance", chainId: 0, buyPx: Number(b.askPrice) / usdtPerUsd, sellPx: Number(b.bidPrice) / usdtPerUsd, source: "best bid/ask, USDT→USD via USDC/USDT book" },
      });
    } catch { /* no route for this asset: skip */ }
  }));
  return out;
};
