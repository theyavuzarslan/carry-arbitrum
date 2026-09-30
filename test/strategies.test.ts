import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeFunctionData } from "viem";
import { gmxExchangeRouterAbi } from "../src/abis.ts";
import { GMX, TOKENS } from "../src/config.ts";
import { buildGmxOrder } from "../src/execution/gmx.ts";
import { planActions } from "../src/execution/planner.ts";
import { walletOpportunities } from "../src/portfolio/opportunities.ts";
import { rayToApy } from "../src/sources/aave.ts";
import { assemble, borrowRoutes, makeContext } from "../src/strategies/common.ts";
import { scanMarket } from "../src/strategies/index.ts";
import type { MarketSnapshot } from "../src/types.ts";

const snap = JSON.parse(readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8")) as MarketSnapshot;

test("Aave ray rate converts to compounded APY", () => {
  // 3% APR in ray compounds per second to ~3.0454% APY.
  const apy = rayToApy(3n * 10n ** 25n);
  assert.ok(Math.abs(apy - 0.030454) < 1e-5, String(apy));
  assert.equal(rayToApy(0n), 0);
});

test("scan returns positive, sorted, internally consistent opportunities", () => {
  const opps = scanMarket(snap);
  assert.ok(opps.length > 10);
  for (const o of opps) {
    const gross = o.legs.reduce((s, l) => s + l.weight * l.apr, 0);
    assert.ok(Math.abs(gross - o.grossApr) < 1e-12, `${o.id} gross mismatch`);
    assert.ok(Math.abs(o.netApr - (o.grossApr - o.costApr)) < 1e-12, `${o.id} net mismatch`);
    assert.ok(o.netApr > 0 && o.costApr >= 0 && o.capacityUsd >= 10_000);
    assert.ok(o.risk.score >= 0 && o.risk.score <= 100);
  }
  // Every strategy family is represented on live data.
  const fams = new Set(opps.map((o) => o.strategy));
  for (const f of ["basis", "reverse-basis", "lend-borrow", "fx-carry", "lst-loop", "fixed-carry", "funding-spread"]) assert.ok(fams.has(f as never), `missing ${f}`);
});

test("no opportunity trades an absurd funding rate or a dust pool", () => {
  for (const o of scanMarket(snap)) {
    for (const l of o.legs) if (l.action.endsWith("perp")) assert.ok(Math.abs(l.apr) < 3, `${o.id} uses ${l.apr}`);
  }
});

test("levered basis health factor matches LT x perp leverage", () => {
  const o = scanMarket(snap).find((x) => x.strategy === "basis" && x.params.shape === "levered");
  if (!o) return; // depends on live funding; the formula is checked when present
  const route = borrowRoutes(snap, String(o.params.spot), "USDC").find((r) => r.venue === o.params.lendVenue)!;
  assert.ok(Math.abs(o.risk.healthFactor! - route.liqThreshold * Number(o.params.perpLeverage)) < 1e-9);
});

test("reverse basis sizing lands on the target health factor", () => {
  const ctx = makeContext(snap);
  for (const o of scanMarket(snap).filter((x) => x.strategy === "reverse-basis")) {
    const route = borrowRoutes(snap, "USDC", String(o.params.spot)).find((r) => r.venue === o.params.lendVenue)!;
    const hf = (route.liqThreshold * Number(o.params.supplyWeight)) / Number(o.params.borrowWeight);
    assert.ok(Math.abs(hf - ctx.targetHealthFactor) < 1e-9, `${o.id} HF ${hf}`);
  }
});

test("LST loop leverage respects the loop health-factor target", () => {
  for (const o of scanMarket(snap).filter((x) => x.strategy === "lst-loop")) {
    assert.ok(o.risk.healthFactor! >= 1.1 - 1e-9, `${o.id} HF ${o.risk.healthFactor}`);
    assert.ok(o.leverage <= 5 + 1e-9);
  }
});

test("costs scale inversely with the holding horizon", () => {
  const legs = [{ action: "swap" as const, venue: "uniswap-v3", symbol: "USDC→ARB", weight: 1, apr: 0 }, { action: "short-perp" as const, venue: "gmx-v2", symbol: "ARB", weight: 1, apr: 0.1 }];
  const base = { id: "x", strategy: "basis" as const, title: "", thesis: "", legs, capacityUsd: 1e6, riskFactors: [], executable: true, params: {} };
  const a = assemble(makeContext(snap, { horizonDays: 30 }), base);
  const b = assemble(makeContext(snap, { horizonDays: 60 }), base);
  assert.ok(Math.abs(a.costApr - 2 * b.costApr) < 1e-12);
});

test("GMX order encodes sendWnt, sendTokens, createOrder with a correct acceptable price", () => {
  const tx = buildGmxOrder({ account: "0x000000000000000000000000000000000000dEaD", market: "0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407", collateralToken: TOKENS.USDC, collateralAmount: 3_333_000_000n, sizeUsd: 6_666, isLong: false, markPx: 0.2, indexDecimals: 18, slippageBps: 50 });
  assert.equal(tx.to, GMX.EXCHANGE_ROUTER);
  assert.equal(tx.value, GMX.EXECUTION_FEE_WEI);
  const outer = decodeFunctionData({ abi: gmxExchangeRouterAbi, data: tx.data });
  const calls = outer.args[0] as `0x${string}`[];
  const names = calls.map((c) => decodeFunctionData({ abi: gmxExchangeRouterAbi, data: c }).functionName);
  assert.deepEqual(names, ["sendWnt", "sendTokens", "createOrder"]);
  const order = decodeFunctionData({ abi: gmxExchangeRouterAbi, data: calls[2]! }).args[0] as { numbers: { sizeDeltaUsd: bigint; acceptablePrice: bigint }; isLong: boolean; orderType: number };
  assert.equal(order.isLong, false);
  assert.equal(order.orderType, 2);
  assert.equal(order.numbers.sizeDeltaUsd, 6_666n * 10n ** 30n);
  // Short increase sells: acceptable = 0.2 * 0.995 = 0.199 USD, scaled by 10^(30-18).
  assert.equal(order.numbers.acceptablePrice, 199_000_000_000n);
});

test("planner builds the expected action sequence for every executable strategy", () => {
  for (const o of scanMarket(snap, { executableOnly: true })) {
    if (o.capacityUsd < 1_000) continue;
    const { actions } = planActions(o, Math.min(1_000, o.capacityUsd), snap);
    assert.ok(actions.length > 0, o.id);
    if (o.strategy === "basis") assert.equal(actions.at(-1)!.t, "gmx.order");
    if (o.strategy === "reverse-basis") assert.ok(actions.some((a) => a.t === "gmx.order" && a.isLong));
    if (o.strategy === "lst-loop") assert.ok(actions.filter((a) => a.t === "aave.borrow" || a.t === "comet.withdraw").length >= 1);
  }
});

test("planner refuses non-executable and oversized trades", () => {
  const info = scanMarket(snap).find((o) => !o.executable)!;
  assert.throws(() => planActions(info, 1_000, snap), /not executable/);
  const exec = scanMarket(snap, { executableOnly: true })[0]!;
  assert.throws(() => planActions(exec, exec.capacityUsd * 2, snap), /exceeds capacity/);
});

test("wallet: idle stable next to same-asset debt suggests repaying", () => {
  const usdc = snap.lending.find((m) => m.venue === "aave-v3" && m.symbol === "USDC")!;
  const opps = walletOpportunities(snap, [
    { venue: "wallet", kind: "balance", symbol: "USDC", amount: 25_000, usd: 25_000, apr: 0 },
    { venue: "aave-v3", kind: "borrow", symbol: "USDC", amount: 100_000, usd: 100_000, apr: -usdc.borrowApr! },
  ], { healthFactor: 1.2, collateralUsd: 150_000, debtUsd: 100_000, eMode: 0 }, scanMarket(snap));
  assert.equal(opps[0]!.params.action, "deleverage", "health alert sorts first");
  const repay = opps.find((o) => o.params.action === "repay");
  assert.ok(repay, "repay suggestion present");
  assert.ok(Math.abs(repay!.walletImpact!.amountUsd - 25_000) < 1e-6);
});
