import { getJson } from "../rpc.ts";
import { GMX } from "../config.ts";
import type { Address, PerpMarket } from "../types.ts";

/**
 * GMX v2 on Arbitrum via GMX's public API.
 *
 * Units, checked on 2026-09-30 against the DataStore: `/markets/info` funding and borrowing rates are
 * ANNUALIZED fractions scaled by 1e30. For ETH/USD [ETH-USDC], fundingRateLong / 1e30 / 31,536,000
 * = 1.1706e-9, and DataStore SAVED_FUNDING_FACTOR_PER_SECOND for that market = 1.1708e-9 (1e30 scale).
 * Positive means that side PAYS. `netRate = funding + borrowing`, so our carry = -netRate.
 */
interface MarketInfo {
  name: string; marketToken: Address; indexToken: Address; longToken: Address; shortToken: Address;
  isListed: boolean;
  openInterestLong: string; openInterestShort: string;
  availableLiquidityLong: string; availableLiquidityShort: string;
  fundingRateLong?: string; fundingRateShort?: string;
  borrowingRateLong?: string; borrowingRateShort?: string;
  netRateLong?: string; netRateShort?: string;
}
interface Token { symbol: string; address: Address; decimals: number; synthetic?: boolean }
interface Ticker { tokenAddress: Address; tokenSymbol: string; minPrice: string; maxPrice: string }

const E30 = 1e30;
const n30 = (s: string | undefined): number => (s ? Number(BigInt(s)) / E30 : 0);

export interface GmxSnapshot {
  perps: PerpMarket[];
  prices: Record<string, number>; // symbol -> USD, from GMX oracle tickers
  tokens: Token[];
}

export const readGmx = async (): Promise<GmxSnapshot> => {
  const [info, tokens, tickers] = await Promise.all([
    getJson<{ markets: MarketInfo[] }>(`${GMX.API}/markets/info`),
    getJson<{ tokens: Token[] }>(`${GMX.API}/tokens`),
    getJson<Ticker[]>(`${GMX.API}/prices/tickers`),
  ]);
  const tokenBy = new Map(tokens.tokens.map((t) => [t.address.toLowerCase(), t]));
  const prices: Record<string, number> = {};
  const priceByAddr = new Map<string, number>();
  for (const t of tickers) {
    const tok = tokenBy.get(t.tokenAddress.toLowerCase());
    if (!tok) continue;
    // GMX prices are USD * 1e30 / 10^tokenDecimals per smallest unit.
    const px = ((Number(BigInt(t.minPrice)) + Number(BigInt(t.maxPrice))) / 2) * 10 ** tok.decimals / E30;
    priceByAddr.set(t.tokenAddress.toLowerCase(), px);
    if (!(tok.symbol in prices)) prices[tok.symbol] = px;
  }
  const perps: PerpMarket[] = [];
  for (const m of info.markets) {
    if (!m.isListed || m.netRateLong === undefined || m.name.startsWith("SWAP-ONLY")) continue;
    const idx = tokenBy.get(m.indexToken.toLowerCase());
    if (!idx) continue;
    const symbol = m.name.split("/")[0]!;
    perps.push({
      venue: "gmx-v2",
      symbol,
      name: m.name,
      markPx: priceByAddr.get(m.indexToken.toLowerCase()) ?? 0,
      longCarryApr: -n30(m.netRateLong),
      shortCarryApr: -n30(m.netRateShort),
      openInterestLongUsd: n30(m.openInterestLong),
      openInterestShortUsd: n30(m.openInterestShort),
      availableLongUsd: n30(m.availableLiquidityLong),
      availableShortUsd: n30(m.availableLiquidityShort),
      executable: true,
      source: "gmx-api",
      gmx: { marketToken: m.marketToken, indexToken: m.indexToken, longToken: m.longToken, shortToken: m.shortToken, indexDecimals: idx.decimals },
    });
  }
  return { perps, prices, tokens: tokens.tokens };
};
