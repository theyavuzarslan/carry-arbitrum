import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULTS } from "./config.ts";
import { execute, readAccountState, startFork, type Fork, type Mode } from "./execution/executor.ts";
import { getClient } from "./rpc.ts";
import { getSnapshot } from "./snapshot.ts";
import { riskAdjusted, scanMarket } from "./strategies/index.ts";
import type { Address, Opportunity } from "./types.ts";

export interface BotPosition {
  opportunityId: string;
  strategy: string;
  title: string;
  openedAt: string;
  capitalUsd: number;
  entryNetApr: number;
  currentNetApr?: number;
  accruedUsd: number;
  status: "open" | "closed" | "unwinding";
  weakScans: number;
  exposure?: string;
  txs: string[];
}

/** What a trade's carry depends on: two trades on the same GMX market or yield source are one bet. */
const exposureOf = (o: Opportunity): string => String(o.params.perpMarket ?? o.params.target ?? `${o.params.collateral}/${o.params.debt ?? o.params.funding}`);

export interface BotState {
  mode: "off" | "dry-run" | "fork" | "live";
  running: boolean;
  account?: string;
  budgetUsd: number;
  lastScanAt?: string;
  positions: BotPosition[];
  log: { at: string; level: "info" | "warn" | "action"; msg: string }[];
}

const FILE = new URL("../.state/bot.json", import.meta.url);

export const loadState = async (): Promise<BotState> => {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as BotState;
  } catch {
    return { mode: "off", running: false, budgetUsd: 0, positions: [], log: [] };
  }
};

const save = async (s: BotState) => {
  await mkdir(new URL("../.state/", import.meta.url), { recursive: true });
  s.log = s.log.slice(-300);
  await writeFile(FILE, JSON.stringify(s, null, 1));
};

export interface BotConfig {
  mode: Exclude<Mode, "plan"> | "dry-run";
  budgetUsd: number;
  ticketUsd: number;
  intervalSec: number;
  minNetApr: number;
  exitNetApr: number;
  maxRisk: number;
  maxPositions: number;
  iterations?: number;
}

export const defaultBotConfig = (): BotConfig => ({
  mode: "dry-run",
  budgetUsd: Number(process.env.CARRY_BUDGET_USD ?? 25_000),
  ticketUsd: Number(process.env.CARRY_TICKET_USD ?? 10_000),
  intervalSec: Number(process.env.CARRY_INTERVAL_SEC ?? 300),
  minNetApr: DEFAULTS.minNetApr,
  exitNetApr: Number(process.env.CARRY_EXIT_NET_APR ?? 0.01),
  maxRisk: DEFAULTS.maxRiskScore,
  maxPositions: 3,
});

/**
 * The carry desk loop.
 *  1. Snapshot every market and rank opportunities.
 *  2. Mark open positions to the current carry; accrue paper P&L; exit after two weak scans.
 *  3. In fork/live mode, check the account health factor and flag deleveraging below the floor.
 *  4. If budget is free, enter the best executable opportunity that passes the risk gate.
 */
export const runBot = async (cfg: BotConfig, log: (s: string) => void = console.log): Promise<void> => {
  const state = await loadState();
  state.mode = cfg.mode;
  state.running = true;
  state.budgetUsd = cfg.budgetUsd;
  const note = (level: "info" | "warn" | "action", msg: string) => {
    state.log.push({ at: new Date().toISOString(), level, msg });
    log(`[${level}] ${msg}`);
  };
  let fork: Fork | undefined;
  let account: Address | undefined;
  const pk = process.env.CARRY_PRIVATE_KEY as Hex | undefined;
  if (cfg.mode === "fork") {
    fork = await startFork();
    account = (state.account as Address) ?? ("0x00000000000000000000000000000000CA441e57" as Address);
    note("info", `fork mode on ${fork.url}; bot account ${account}`);
  } else if (cfg.mode === "live") {
    if (!pk) throw new Error("live mode needs CARRY_PRIVATE_KEY");
    account = privateKeyToAccount(pk).address;
    note("warn", `LIVE mode for ${account}; budget $${cfg.budgetUsd}, ticket $${cfg.ticketUsd}`);
  }
  state.account = account;
  const stop = () => { state.running = false; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let i = 0;
  let last = Date.now();
  try {
    while (state.running && (cfg.iterations === undefined || i < cfg.iterations)) {
      i++;
      const snap = await getSnapshot({ maxAgeMs: Math.min(60_000, cfg.intervalSec * 1000) });
      const all = scanMarket(snap, { minNetApr: -10, minCapacityUsd: 0 });
      state.lastScanAt = snap.asOf;
      if (snap.errors.length) note("warn", `sources down: ${snap.errors.join("; ")}`);
      const now = Date.now();
      const dtYears = (now - last) / (365 * 86_400_000);
      last = now;

      // 2. Mark to market.
      for (const p of state.positions.filter((x) => x.status === "open")) {
        const cur = all.find((o) => o.id === p.opportunityId);
        p.currentNetApr = cur?.netApr ?? 0;
        p.accruedUsd += p.capitalUsd * p.currentNetApr * dtYears;
        if (!cur || cur.netApr < cfg.exitNetApr) {
          p.weakScans++;
          note("warn", `${p.title}: carry ${((p.currentNetApr) * 100).toFixed(2)}% below exit ${(cfg.exitNetApr * 100).toFixed(2)}% (${p.weakScans}/2)`);
          if (p.weakScans >= 2) {
            p.status = cfg.mode === "dry-run" ? "closed" : "unwinding";
            note("action", `EXIT ${p.title}: carry decayed. ${cfg.mode === "dry-run" ? "Paper position closed." : "Unwind flagged: close the perp first, then repay and withdraw."}`);
          }
        } else p.weakScans = 0;
      }

      // 3. Health check.
      if (account && (fork || cfg.mode === "live")) {
        const st = await readAccountState(fork?.client ?? getClient(), account);
        if (st.aave.debtUsd > 0 && st.aave.healthFactor < DEFAULTS.minHealthFactor) note("action", `DELEVERAGE: Aave HF ${st.aave.healthFactor.toFixed(2)} < ${DEFAULTS.minHealthFactor}; repay debt to reach ${DEFAULTS.targetHealthFactor}`);
        else if (st.aave.debtUsd > 0) note("info", `Aave HF ${st.aave.healthFactor.toFixed(2)}, debt $${st.aave.debtUsd.toFixed(0)}, GMX pending orders ${typeof st.gmxPendingOrders === "string" ? st.gmxPendingOrders : st.gmxPendingOrders.length}`);
      }

      // 4. Entry.
      const open = state.positions.filter((x) => x.status === "open");
      const used = open.reduce((s, p) => s + p.capitalUsd, 0);
      const free = cfg.budgetUsd - used;
      const candidates: Opportunity[] = all
        .filter((o) => o.executable && o.scope === "market" && o.netApr >= cfg.minNetApr && o.risk.score <= cfg.maxRisk && o.capacityUsd >= cfg.ticketUsd * 3 && !open.some((p) => p.opportunityId === o.id || p.exposure === exposureOf(o)))
        .sort((a, b) => riskAdjusted(b) - riskAdjusted(a));
      const best = candidates[0];
      if (!best) note("info", `scan ${i}: ${all.filter((o) => o.netApr > 0).length} positive-carry ideas, none pass the gate (net ≥ ${(cfg.minNetApr * 100).toFixed(1)}%, risk ≤ ${cfg.maxRisk}, capacity ≥ 3x ticket)`);
      else if (free < cfg.ticketUsd || open.length >= cfg.maxPositions) note("info", `scan ${i}: best is ${best.title} at ${(best.netApr * 100).toFixed(2)}% but budget is fully deployed`);
      else {
        note("action", `ENTER ${best.title}: net ${(best.netApr * 100).toFixed(2)}%, risk ${best.risk.grade}/${best.risk.score}, $${cfg.ticketUsd}`);
        const pos: BotPosition = { opportunityId: best.id, strategy: best.strategy, title: best.title, openedAt: new Date().toISOString(), capitalUsd: cfg.ticketUsd, entryNetApr: best.netApr, currentNetApr: best.netApr, accruedUsd: 0, status: "open", weakScans: 0, exposure: exposureOf(best), txs: [] };
        try {
          const res = await execute(best, snap, { mode: cfg.mode === "dry-run" ? "plan" : cfg.mode, capitalUsd: cfg.ticketUsd, account, fork, privateKey: pk, confirm: cfg.mode === "live", log: (s) => note("info", s) });
          pos.txs = res.txs.length ? res.txs.map((t) => t.hash) : res.plan.steps.map((s) => `planned: ${s.label}`);
          state.positions.push(pos);
          if (res.after) note("info", `after entry: Aave HF ${res.after.aave.healthFactor === Infinity ? "∞" : res.after.aave.healthFactor.toFixed(2)}, GMX pending orders ${typeof res.after.gmxPendingOrders === "string" ? res.after.gmxPendingOrders : res.after.gmxPendingOrders.length}`);
        } catch (e) {
          note("warn", `entry failed for ${best.id}: ${(e as Error).message}`);
        }
      }
      await save(state);
      if (!state.running || (cfg.iterations !== undefined && i >= cfg.iterations)) break;
      await new Promise((r) => setTimeout(r, cfg.intervalSec * 1000));
    }
  } finally {
    state.running = false;
    await save(state);
    fork?.stop();
  }
};
