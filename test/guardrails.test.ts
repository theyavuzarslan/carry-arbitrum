import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { blocksExecution, securityOf, tokensOf, type GuardReport } from "../src/guardrails/index.ts";
import { evaluate } from "../src/guardrails/tokenSecurity.ts";
import { scanMarket } from "../src/strategies/index.ts";
import type { MarketSnapshot } from "../src/types.ts";

const snap = JSON.parse(readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8")) as MarketSnapshot;
const A = "0x0000000000000000000000000000000000000001" as const;

test("hard token failures block; admin powers common to majors are information only", () => {
  assert.equal(evaluate(42161, A, { is_honeypot: "1", is_open_source: "1" }).verdict, "block");
  assert.equal(evaluate(42161, A, { sell_tax: "0.05", is_open_source: "1" }).verdict, "block");
  assert.equal(evaluate(42161, A, { owner_change_balance: "1", is_open_source: "1" }).verdict, "block");
  assert.equal(evaluate(42161, A, { is_open_source: "0" }).verdict, "block");
  const usdcLike = evaluate(42161, A, { is_proxy: "1", is_blacklisted: "1", is_open_source: "1" });
  assert.equal(usdcLike.verdict, "pass");
  assert.match(usdcLike.reasons.join(), /admin powers \(info\)/);
  assert.equal(evaluate(42161, A, { is_mintable: "1", is_open_source: "1" }).verdict, "warn");
  assert.equal(evaluate(98866, A, undefined).verdict, "unverified");
});

test("a GoPlus block makes an opportunity non-executable but keeps it visible", () => {
  const o = scanMarket(snap, { minNetApr: -10, minCapacityUsd: 0 }).find((x) => x.executable && tokensOf(x, snap).length)!;
  const t = tokensOf(o, snap)[0]!;
  const blocked = { ...snap, security: { [`${t.chainId}:${t.address.toLowerCase()}`]: { ...evaluate(t.chainId, t.address, { is_honeypot: "1", is_open_source: "1" }), symbol: t.symbol } } };
  assert.equal(securityOf(o, blocked)[0]!.v.verdict, "block");
  const again = scanMarket(blocked, { minNetApr: -10, minCapacityUsd: 0 }).find((x) => x.id === o.id)!;
  assert.equal(again.executable, false);
  assert.match(again.whyNotExecutable!, /token security \(GoPlus\)/);
});

test("live mode treats unverified tokens as blocking; fork mode does not", () => {
  const r: GuardReport = { verdict: "warn", capitalUsd: 1, asOf: "", checks: [{ name: "security X", verdict: "unverified", detail: "chain not covered" }] };
  assert.equal(blocksExecution(r, "fork").length, 0);
  assert.equal(blocksExecution(r, "live").length, 1);
});

test("perp capacity never exceeds 15% of the market's open interest", () => {
  for (const o of scanMarket(snap)) for (const l of o.legs) {
    if (!l.action.endsWith("perp") || l.venue !== "gmx-v2") continue;
    const p = snap.perps.find((x) => x.venue === "gmx-v2" && x.name === l.symbol)!;
    assert.ok(o.capacityUsd * l.weight <= 0.15 * (p.openInterestLongUsd + p.openInterestShortUsd) + 1e-6, o.id);
  }
});
