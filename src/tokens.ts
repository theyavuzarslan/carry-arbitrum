import { TOKENS } from "./config.ts";
import type { Address } from "./types.ts";

const byAddress = new Map<string, string>(Object.entries(TOKENS).map(([sym, addr]) => [addr.toLowerCase(), sym]));

/** Canonical symbol for a token address (USDC.e reports "USDC", USDT0 reports "USD₮0"). */
export const canonicalSymbol = (address: string | undefined, fallback: string): string => {
  if (address) {
    const s = byAddress.get(address.toLowerCase());
    if (s) return s;
  }
  return normalizeSymbol(fallback);
};

/** Normalise venue spellings so markets from different sources can be joined. */
const CANON: Record<string, string> = Object.fromEntries(
  ["sUSDai", "USDai", "sUSDS", "USDS", "sUSDe", "USDe", "wstETH", "weETH", "rETH", "rsETH", "ezETH", "WETH", "WBTC", "tBTC", "USDC", "USDT", "DAI", "GHO", "EURS", "ARB", "LINK", "GMX"].map((s) => [s.toUpperCase(), s]),
);

export const normalizeSymbol = (s: string): string => {
  const u0 = s.replace("₮", "T").replace(/^USDT0$/i, "USDT").replace(/^WBTC\.b$/i, "WBTC").trim();
  const u = CANON[u0.toUpperCase()] ?? u0;
  if (/^eth$/i.test(u)) return "WETH";
  if (/^btc$/i.test(u)) return "WBTC";
  if (/^weth$/i.test(u)) return "WETH";
  if (/^wsteth$/i.test(u)) return "wstETH";
  if (/^weeth$/i.test(u)) return "weETH";
  return u;
};

export const tokenAddress = (symbol: string): Address | undefined => (TOKENS as Record<string, Address>)[symbol];

export const isStable = (s: string): boolean => /^(USDC|USDC\.e|USDT|DAI|FRAX|LUSD|GHO|USDe|sUSDe|USDai|sUSDai|MAI|USDS|sUSDS|crvUSD|USDG)$/i.test(s);
export const isEthLike = (s: string): boolean => /^(WETH|ETH|wstETH|weETH|rETH|ezETH|rsETH|cbETH|stETH)$/i.test(s);
export const isEuro = (s: string): boolean => /^(EURS|EURe|EURC|agEUR|EURA)$/i.test(s);
