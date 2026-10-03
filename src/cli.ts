#!/usr/bin/env node
import { parseArgs } from "node:util";
import { isAddress, type Hex } from "viem";
import { defaultBotConfig, runBot, type BotConfig } from "./bot.ts";
import { execute } from "./execution/executor.ts";
import { toJson } from "./json.ts";
import { walletReport } from "./portfolio/opportunities.ts";
import { serve } from "./server.ts";
import { runGuardrails } from "./guardrails/index.ts";
import { getSnapshot } from "./snapshot.ts";
import { riskAdjusted, scanMarket } from "./strategies/index.ts";
import type { Address, Opportunity } from "./types.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean" },
    exec: { type: "boolean" },
    strategy: { type: "string" },
    top: { type: "string" },
    capital: { type: "string" },
    account: { type: "string" },
    mode: { type: "string" },
    yes: { type: "boolean" },
    interval: { type: "string" },
    budget: { type: "string" },
    ticket: { type: "string" },
    iterations: { type: "string" },
    port: { type: "string" },
    horizon: { type: "string" },
    "min-net": { type: "string" },
    fresh: { type: "boolean" },
  },
});
const [cmd = "help", arg] = positionals;

const pct = (x: number) => `${x >= 0 ? " " : ""}${(x * 100).toFixed(2)}%`;
const usd = (x: number) => (Math.abs(x) >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : Math.abs(x) >= 1e3 ? `$${(x / 1e3).toFixed(0)}k` : `$${x.toFixed(0)}`);
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

const table = (opps: Opportunity[]) => {
  console.log(`${pad("#", 3)} ${pad("strategy", 14)} ${pad("net APR", 8)} ${pad("risk", 6)} ${pad("lev", 5)} ${pad("capacity", 9)} ${pad("exec", 5)} title`);
  opps.forEach((o, i) => console.log(`${pad(String(i + 1), 3)} ${pad(o.strategy, 14)} ${pad(pct(o.netApr), 8)} ${pad(`${o.risk.grade}/${o.risk.score}`, 6)} ${pad(`${o.leverage.toFixed(1)}x`, 5)} ${pad(usd(o.capacityUsd), 9)} ${pad(o.executable ? "yes" : "info", 5)} ${o.title}`));
};

const snapOpts = () => ({ maxAgeMs: values.fresh ? 0 : 60_000 });
const scanOpts = () => ({ horizonDays: values.horizon ? Number(values.horizon) : undefined, minNetApr: values["min-net"] ? Number(values["min-net"]) : undefined });

const findOpp = async (id: string) => {
  const snap = await getSnapshot(snapOpts());
  const all = scanMarket(snap, { ...scanOpts(), minNetApr: -10, minCapacityUsd: 0 });
  const byIndex = Number(id);
  const ranked = scanMarket(snap, scanOpts());
  const opp = Number.isInteger(byIndex) && byIndex > 0 ? ranked[byIndex - 1] : all.find((o) => o.id === id) ?? all.find((o) => o.id.includes(id));
  if (!opp) throw new Error(`no opportunity matches "${id}". Run \`scan\` and pass a rank number or id.`);
  return { snap, opp };
};

const main = async () => {
  switch (cmd) {
    case "scan": {
      const snap = await getSnapshot(snapOpts());
      let opps = scanMarket(snap, { ...scanOpts(), executableOnly: values.exec });
      if (values.strategy) opps = opps.filter((o) => o.strategy === values.strategy);
      const top = Number(values.top ?? 25);
      if (values.json) return console.log(toJson({ asOf: snap.asOf, errors: snap.errors, opportunities: opps.slice(0, top) }, 1));
      console.log(`Arbitrum carry scan ${snap.asOf}: ${snap.lending.length} lending markets, ${snap.perps.filter((p) => p.venue === "gmx-v2").length} GMX perps, ${snap.fixed.length} Pendle PTs, ${snap.holdYields.length} native yields`);
      if (snap.errors.length) console.log(`sources down: ${snap.errors.join("; ")}`);
      console.log(`ranked by risk-adjusted net APR (net × (1 − risk/150)); costs amortized over ${values.horizon ?? 30} days\n`);
      table(opps.slice(0, top));
      const counts = opps.reduce<Record<string, number>>((a, o) => ((a[o.strategy] = (a[o.strategy] ?? 0) + 1), a), {});
      console.log(`\n${opps.length} opportunities: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}. ${opps.filter((o) => o.executable).length} executable.`);
      console.log(`Details: node src/cli.ts plan <rank|id> --capital 10000`);
      return;
    }
    case "show": {
      const { opp } = await findOpp(arg ?? "1");
      return console.log(toJson(opp, 1));
    }
    case "wallet": {
      if (!arg || !isAddress(arg)) throw new Error("usage: wallet <0x address>");
      const snap = await getSnapshot(snapOpts());
      const r = await walletReport(arg as Address, snap);
      if (values.json) return console.log(toJson(r, 1));
      console.log(`Wallet ${r.address} on Arbitrum`);
      console.log(`net worth ${usd(r.netWorthUsd)}, current carry ${usd(r.currentCarryUsdPerYear)}/yr (${pct(r.currentCarryApr)}), available uplift +${usd(r.potentialCarryUsdPerYear)}/yr`);
      if (r.aave) console.log(`Aave: collateral ${usd(r.aave.collateralUsd)}, debt ${usd(r.aave.debtUsd)}, health factor ${r.aave.healthFactor === Infinity ? "∞" : r.aave.healthFactor.toFixed(2)}, e-mode ${r.aave.eMode}`);
      console.log("\npositions:");
      for (const p of r.positions.filter((p) => p.usd >= 1)) console.log(`  ${pad(p.venue, 12)} ${pad(p.kind, 8)} ${pad(p.symbol, 22)} ${pad(usd(p.usd), 8)} ${pct(p.apr)}${p.detail?.side ? ` ${p.detail.side}` : ""}`);
      console.log("\nopportunities:");
      if (!r.opportunities.length) console.log("  none: this wallet is already near the best carry the bot can find for it");
      for (const o of r.opportunities) console.log(`  ${o.params.action === "deleverage" ? "!!" : "+ "} ${o.title}\n     ${o.walletImpact ? `${o.walletImpact.usdPerYear >= 0 ? "+" : ""}${usd(o.walletImpact.usdPerYear)}/yr on ${usd(o.walletImpact.amountUsd)}` : ""} · risk ${o.risk.grade} · ${o.executable ? "executable" : "advice"}\n     ${o.thesis}`);
      return;
    }
    case "plan":
    case "execute": {
      const { snap, opp } = await findOpp(arg ?? "1");
      const capital = Number(values.capital ?? 10_000);
      const mode = cmd === "plan" ? "plan" : ((values.mode ?? "fork") as "fork" | "live");
      console.log(`${opp.title}\n${opp.thesis}\nnet ${pct(opp.netApr)} (gross ${pct(opp.grossApr)}, costs ${pct(opp.costApr)}), risk ${opp.risk.grade}/${opp.risk.score}: ${opp.risk.factors.join("; ")}\n`);
      console.log("legs:");
      for (const l of opp.legs) console.log(`  ${pad(l.action, 11)} ${pad(l.venue, 12)} ${pad(l.symbol, 26)} ×${l.weight.toFixed(2)}  ${pct(l.apr)}${l.note ? `  (${l.note})` : ""}`);
      const res = await execute(opp, snap, { mode, capitalUsd: capital, account: values.account as Address | undefined, privateKey: process.env.CARRY_PRIVATE_KEY as Hex | undefined, confirm: values.yes });
      console.log(`\n${mode === "plan" ? "transactions (not sent)" : `sent ${res.txs.length} transactions`} for $${capital}:`);
      if (mode === "plan") res.plan.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.label}\n     to ${s.to}${s.value ? ` value ${s.value}` : ""} data ${s.data.slice(0, 10)}…(${(s.data.length - 2) / 2} bytes)`));
      for (const n of res.plan.notes) console.log(`note: ${n}`);
      if (res.plan.guard) for (const c of res.plan.guard.checks.filter((x) => x.verdict !== "pass")) console.log(`guardrail ${c.verdict.toUpperCase()}: ${c.name}: ${c.detail}`);
      if (res.after) console.log(`\nafter: ${toJson(res.after, 1)}`);
      return;
    }
    case "run": {
      const cfg: BotConfig = { ...defaultBotConfig(), mode: (values.mode ?? "dry-run") as BotConfig["mode"] };
      if (values.interval) cfg.intervalSec = Number(values.interval);
      if (values.budget) cfg.budgetUsd = Number(values.budget);
      if (values.ticket) cfg.ticketUsd = Number(values.ticket);
      if (values.iterations) cfg.iterations = Number(values.iterations);
      if (values["min-net"]) cfg.minNetApr = Number(values["min-net"]);
      return runBot(cfg);
    }
    case "check": {
      // Pre-trade guardrails at a size: token security and entry/exit liquidity.
      const { snap, opp } = await findOpp(arg ?? "1");
      const capital = Number(values.capital ?? 10_000);
      const g = await runGuardrails(opp, capital, snap);
      console.log(`${opp.title}\nguardrails at $${capital.toLocaleString()}: ${g.verdict.toUpperCase()}\n`);
      for (const c of g.checks) console.log(`  ${c.verdict === "pass" ? "ok   " : c.verdict === "warn" ? "WARN " : c.verdict === "block" ? "BLOCK" : "UNVER"} ${c.name}: ${c.detail}`);
      return;
    }
    case "demo": {
      // Two-minute tour on live data: executable market carry, then a real wallet.
      const snap = await getSnapshot(snapOpts());
      console.log(`== Executable carry on Arbitrum right now (${snap.asOf})\n`);
      table(scanMarket(snap, { executableOnly: true }).slice(0, 10));
      const addr = (arg && isAddress(arg) ? arg : "0xAFfD35301381265Ed740098A2394894B3A2d6500") as Address;
      const r = await walletReport(addr, snap);
      console.log(`\n== Wallet ${addr}: net ${usd(r.netWorthUsd)}, carry ${usd(r.currentCarryUsdPerYear)}/yr, uplift +${usd(r.potentialCarryUsdPerYear)}/yr`);
      for (const o of r.opportunities) console.log(`  ${o.params.action === "deleverage" ? "!!" : "+ "} ${o.title}  (${o.walletImpact ? `${usd(o.walletImpact.usdPerYear)}/yr` : ""})`);
      console.log(`\nNext: node src/cli.ts execute <id> --mode fork   (ids: node src/cli.ts scan --exec --json)`);
      return;
    }
    case "serve":
      serve(values.port ? Number(values.port) : undefined);
      return new Promise(() => {});
    default:
      console.log(`carry — onchain carry desk for Arbitrum

  scan [--exec] [--strategy basis|reverse-basis|lend-borrow|fx-carry|lst-loop|fixed-carry|funding-spread] [--top N] [--json] [--horizon days]
  show <rank|id>                       full opportunity JSON
  wallet <0xaddress> [--json]          positions, current carry, and what to do about it
  plan <rank|id> [--capital 10000]     exact transactions, nothing sent
  execute <rank|id> --mode fork        run it on an anvil fork of Arbitrum (needs Foundry)
  execute <rank|id> --mode live --yes  sign with CARRY_PRIVATE_KEY (capped by CARRY_MAX_CAPITAL_USD)
  run [--mode dry-run|fork|live] [--interval 300] [--budget 25000] [--ticket 10000] [--iterations N]
  serve [--port 8787]                  dashboard + JSON API
  demo [0xaddress]                     top executable trades + a wallet report
  check <rank|id> [--capital 10000]    guardrails: token security (GoPlus) + entry/exit liquidity`);
  }
};

main().then(() => { if (cmd !== "serve" && cmd !== "run") process.exit(0); }, (e) => { console.error(`error: ${(e as Error).message}`); process.exit(1); });
