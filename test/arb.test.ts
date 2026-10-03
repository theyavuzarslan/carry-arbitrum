import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cexDexArbs, xchainArbs } from "../src/strategies/arb.ts";
import { makeContext } from "../src/strategies/common.ts";
import { scanMarket } from "../src/strategies/index.ts";
import type { MarketSnapshot } from "../src/types.ts";

const base = JSON.parse(readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8")) as MarketSnapshot;
const pair = (uniBuy: number, uniSell: number, cexBid: number, cexAsk: number) => ({
  asset: "LINK", sizeUsd: 10_000, asOf: "",
  a: { venue: "uniswap-v3", chainId: 42161, buyPx: uniBuy, sellPx: uniSell, source: "" },
  b: { venue: "binance", chainId: 0, buyPx: cexAsk, sellPx: cexBid, source: "" },
});

test("CEX-DEX edge is net of the taker fee and only in the profitable direction", () => {
  const snap = { ...base, arb: { cexDex: [pair(14.00, 13.98, 14.07, 14.08)] } };
  const opps = cexDexArbs(makeContext(snap));
  assert.equal(opps.length, 1);
  assert.equal(opps[0]!.params.buyVenue, "uniswap-v3");
  assert.ok(Math.abs(opps[0]!.netApr - (14.07 / 14.0 - 1 - 0.001)) < 1e-12);
  assert.equal(opps[0]!.params.oneOff, true);
  assert.equal(opps[0]!.executable, false);
});

test("no edge after fees means no opportunity", () => {
  const snap = { ...base, arb: { cexDex: [pair(14.00, 13.99, 14.005, 14.01)] } };
  assert.equal(cexDexArbs(makeContext(snap)).length, 0);
});

test("one-off arbitrage ranks after every carry trade", () => {
  const snap = { ...base, arb: { cexDex: [pair(10, 9.99, 12, 12.01)] } }; // a huge 20% edge
  const opps = scanMarket(snap);
  const firstArb = opps.findIndex((o) => o.params.oneOff === true);
  assert.ok(firstArb > 0);
  assert.ok(opps.slice(firstArb).every((o) => o.params.oneOff === true));
});

test("stock-token convergence only uses validated exact matches", () => {
  for (const o of xchainArbs(makeContext(base))) assert.ok(Math.abs(Number(o.params.gapPct)) <= 3);
});
