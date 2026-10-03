/**
 * Arbitrum ecosystem chains the bot can source assets and yields from when Arbitrum One lacks the
 * pair or the pool. All are Arbitrum Nitro chains (Nova = AnyTrust, the rest = Orbit chains), and
 * all are reachable from Arbitrum One through LI.FI in one source-chain transaction.
 * Chain ids, RPCs and LI.FI support checked 2026-10-04 (LI.FI /v1/chains, DefiLlama /v2/chains).
 */
export interface EcoChain {
  id: number;
  name: string;
  slug: string;        // used in venue names, e.g. "robinhood:morpho-blue"
  llamaName: string;   // DefiLlama chain name
  rpc: string;
  explorer: string;
  kind: "orbit" | "anytrust";
  note: string;
}

export const ARBITRUM_ONE = 42161;

export const ECO_CHAINS: EcoChain[] = [
  { id: 4663, name: "Robinhood Chain", slug: "robinhood", llamaName: "Robinhood Chain", rpc: "https://rpc.mainnet.chain.robinhood.com/", explorer: "https://explorer.chain.robinhood.com", kind: "orbit", note: "tokenized US stocks and ETFs, USDG, Morpho vaults" },
  { id: 98866, name: "Plume", slug: "plume", llamaName: "Plume Mainnet", rpc: "https://rpc.plume.org", explorer: "https://explorer.plume.org", kind: "orbit", note: "RWA vaults (Nest), tokenized gold" },
  { id: 33139, name: "ApeChain", slug: "apechain", llamaName: "ApeChain", rpc: "https://rpc.apechain.com", explorer: "https://apescan.io", kind: "orbit", note: "APE ecosystem" },
  { id: 1625, name: "Gravity", slug: "gravity", llamaName: "Gravity", rpc: "https://rpc.gravity.xyz/", explorer: "https://explorer.gravity.xyz", kind: "orbit", note: "Galxe chain" },
  { id: 42170, name: "Arbitrum Nova", slug: "nova", llamaName: "Arbitrum Nova", rpc: "https://arbitrum-nova-rpc.publicnode.com", explorer: "https://nova.arbiscan.io", kind: "anytrust", note: "AnyTrust chain" },
];

export const chainById = (id: number): EcoChain | undefined => ECO_CHAINS.find((c) => c.id === id);

/**
 * GMX index symbol → spot tokens that track it on ecosystem chains.
 * exact: same asset (tokenized share of the same ETF, the same gold ounce).
 * proxy: an ETF that tracks the commodity with fees and tracking error (hedge by notional).
 */
export const SPOT_ALIASES: Record<string, { symbols: string[]; match: "exact" | "proxy"; kind: "stock" | "commodity" | "crypto" }> = {
  SPY: { symbols: ["SPY"], match: "exact", kind: "stock" },
  QQQ: { symbols: ["QQQ"], match: "exact", kind: "stock" },
  SPCX: { symbols: ["SPCX"], match: "exact", kind: "stock" },
  GOLD: { symbols: ["XAUM", "XAUT", "XAUT0", "PAXG"], match: "exact", kind: "commodity" },
  "XAUT.v2": { symbols: ["XAUM", "XAUT", "XAUT0", "PAXG"], match: "exact", kind: "commodity" },
  SILVER: { symbols: ["SLV"], match: "proxy", kind: "commodity" },
  WTIOIL: { symbols: ["USO"], match: "proxy", kind: "commodity" },
};
