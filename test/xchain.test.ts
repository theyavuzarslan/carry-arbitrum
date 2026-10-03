import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SPOT_ALIASES } from "../src/chains.ts";
import { planActions } from "../src/execution/planner.ts";
import { matchSpots } from "../src/sources/xchain.ts";
import { scanMarket } from "../src/strategies/index.ts";
import { makeContext } from "../src/strategies/common.ts";
import { xchainBasisOpportunities, xchainYieldOpportunities } from "../src/strategies/xchain.ts";
import type { MarketSnapshot } from "../src/types.ts";

const snap = JSON.parse(readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8")) as MarketSnapshot;

test("fixture carries the ecosystem layer", () => {
  assert.ok(snap.eco, "eco snapshot present");
  assert.ok(snap.eco!.spots.length > 0 && Object.keys(snap.eco!.quotes).length > 0);
});

test("spot matching only pairs GMX perps that have no Arbitrum One spot", () => {
  for (const s of snap.eco!.spots) {
    assert.ok(!["ETH", "BTC", "ARB", "LINK", "GMX"].includes(s.perpSymbol));
    assert.ok(SPOT_ALIASES[s.perpSymbol], s.perpSymbol);
    if (s.match === "exact") assert.ok(Math.abs(s.priceGapPct) <= 3, `${s.token.symbol} gap ${s.priceGapPct}`);
  }
});

test("an exact match that prices far from the GMX mark is rejected", () => {
  const perp = { venue: "gmx-v2", symbol: "SPY", name: "SPY/USD [ETH-USDC]", markPx: 700 } as never;
  const tok = { chainId: 4663, symbol: "SPY", address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", decimals: 18, priceUsd: 772, name: "SPY" } as const;
  assert.equal(matchSpots([perp], [tok], () => false).length, 0);
  assert.equal(matchSpots([{ ...(perp as object), markPx: 771 } as never], [tok], () => false).length, 1);
});

test("bridge legs are charged both ways and never at a negative cost", () => {
  const ctx = makeContext(snap);
  for (const o of [...xchainBasisOpportunities(ctx), ...xchainYieldOpportunities(ctx)]) {
    const b = o.legs.find((l) => l.action === "bridge")!;
    assert.ok(b && b.chainId && b.costOneWay! >= 0.0005, o.id);
    assert.ok(o.costApr >= 2 * b.costOneWay! * b.weight * (365 / ctx.horizonDays) - 1e-12, `${o.id} cost too low`);
    assert.ok(o.netApr <= o.grossApr, `${o.id} net above gross`);
  }
});

test("cross-chain basis is delta-neutral by notional and plans bridge before the hedge", () => {
  const o = scanMarket(snap, { minNetApr: -10, minCapacityUsd: 0 }).find((x) => x.strategy === "xchain-basis" && x.executable);
  if (!o) return;
  const hold = o.legs.find((l) => l.action === "hold")!;
  const short = o.legs.find((l) => l.action === "short-perp")!;
  assert.equal(hold.weight, short.weight);
  const { actions } = planActions(o, 1_000, snap);
  assert.deepEqual(actions.map((a) => a.t), ["bridge", "gmx.order"]);
});

test("plan-only two-step routes are never marked executable", () => {
  for (const o of xchainYieldOpportunities(makeContext(snap)).filter((x) => x.params.shape === "two-step")) {
    assert.equal(o.executable, false);
    assert.throws(() => planActions(o, 1_000, snap), /not executable/);
  }
});
