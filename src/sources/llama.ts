import { LLAMA_YIELDS, LIDO_APR_API } from "../config.ts";
import { getJson } from "../rpc.ts";
import { normalizeSymbol } from "../tokens.ts";
import type { HoldYield, LendingMarket } from "../types.ts";

interface Pool { pool: string; chain: string; project: string; symbol: string; tvlUsd: number; apy: number | null; apyBase: number | null; apyReward: number | null; underlyingTokens?: string[] | null }
interface LendBorrow { pool: string; apyBaseBorrow: number | null; apyRewardBorrow: number | null; totalSupplyUsd: number | null; totalBorrowUsd: number | null; ltv: number | null; borrowable: boolean | null }

/** Lending venues we read on-chain ourselves; DefiLlama rows for them are dropped to avoid doubles. */
const ONCHAIN = new Set(["aave-v3", "compound-v3"]);
/** Lending-style projects worth scanning market-wide on Arbitrum. */
const LENDING = new Set(["fluid-lending", "dolomite", "morpho-blue", "morpho-v1", "silo-v2", "silo-v1", "radiant-v2", "euler-v2", "lodestar-v1", "spark-savings", "sky-lending", "usd-ai"]);

/**
 * Market-wide lending on Arbitrum from DefiLlama. These venues are scanned so the bot can say
 * "Fluid pays 4.3% on USDT0 while Aave pays 3.0%", but we have no transaction builders for them,
 * so rows are non-executable. `/lendBorrow` carries no chain field, so it is joined on pool id.
 */
export const readLlamaLending = async (minTvlUsd = 1_000_000): Promise<LendingMarket[]> => {
  const [pools, lb] = await Promise.all([
    getJson<{ data: Pool[] }>(`${LLAMA_YIELDS}/pools`, { timeoutMs: 40_000 }),
    getJson<LendBorrow[]>(`${LLAMA_YIELDS}/lendBorrow`, { timeoutMs: 40_000 }).catch(() => [] as LendBorrow[]),
  ]);
  const lbBy = new Map(lb.map((r) => [r.pool, r]));
  return pools.data
    .filter((p) => p.chain === "Arbitrum" && LENDING.has(p.project) && !ONCHAIN.has(p.project) && p.tvlUsd >= minTvlUsd && !p.symbol.includes("-"))
    .map((p) => {
      const b = lbBy.get(p.pool);
      const supply = b?.totalSupplyUsd ?? p.tvlUsd;
      const borrowed = b?.totalBorrowUsd ?? 0;
      return {
        venue: p.project,
        symbol: normalizeSymbol(p.symbol),
        supplyApr: (p.apyBase ?? p.apy ?? 0) / 100,
        rewardApr: (p.apyReward ?? 0) / 100,
        borrowApr: b?.apyBaseBorrow != null && b.borrowable !== false ? b.apyBaseBorrow / 100 : null,
        totalSupplyUsd: supply,
        totalBorrowUsd: borrowed,
        availableUsd: Math.max(0, supply - borrowed),
        ltv: b?.ltv ?? 0,
        liqThreshold: b?.ltv ?? 0,
        canCollateral: (b?.ltv ?? 0) > 0,
        // DefiLlama labels vault rows (e.g. Fluid) by collateral symbol while the borrow rate is for an
        // unnamed debt asset, so borrow data here is ambiguous. We use these rows as supply-side only.
        canBorrow: false,
        executable: false,
        source: "defillama" as const,
      };
    });
};

/**
 * Native yields from holding an asset: LST/LRT staking and yield-bearing stables.
 * wstETH uses Lido's own 7-day SMA; the rest come from DefiLlama's issuer pools.
 */
export const readHoldYields = async (): Promise<HoldYield[]> => {
  const out: HoldYield[] = [];
  const [lido, pools] = await Promise.allSettled([
    getJson<{ data: { smaApr: number } }>(LIDO_APR_API),
    getJson<{ data: Pool[] }>(`${LLAMA_YIELDS}/pools`, { timeoutMs: 40_000 }),
  ]);
  if (lido.status === "fulfilled") out.push({ symbol: "wstETH", apr: lido.value.data.smaApr / 100, source: "lido-api", note: "Lido 7-day SMA staking APR" });
  if (pools.status === "fulfilled") {
    const pick = (project: string, symbol: string, as: string, chain = "Ethereum") => {
      const p = pools.value.data.filter((x) => x.project === project && x.symbol.toUpperCase() === symbol && x.chain === chain).sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
      if (p && !out.some((o) => o.symbol === as)) out.push({ symbol: as, apr: (p.apyBase ?? p.apy ?? 0) / 100, source: "defillama", note: `${project} ${chain}` });
    };
    pick("lido", "STETH", "wstETH");
    pick("ether.fi-stake", "WEETH", "weETH");
    pick("rocket-pool", "RETH", "rETH");
    pick("kelp", "RSETH", "rsETH");
    pick("renzo", "EZETH", "ezETH");
    pick("ethena-usde", "SUSDE", "sUSDe");
    pick("usd-ai", "SUSDAI", "sUSDai", "Arbitrum");
    pick("sky-lending", "SUSDS", "sUSDS");
  }
  return out;
};
