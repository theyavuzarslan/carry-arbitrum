import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress } from "viem";
import { loadState } from "./bot.ts";
import { buildPlan } from "./execution/executor.ts";
import { toJson } from "./json.ts";
import { walletReport } from "./portfolio/opportunities.ts";
import { getSnapshot } from "./snapshot.ts";
import { scanMarket } from "./strategies/index.ts";
import type { Address } from "./types.ts";

const WEB = fileURLToPath(new URL("../web/", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(toJson(body));
};

const body = (req: IncomingMessage): Promise<string> => new Promise((ok, err) => {
  let s = "";
  req.on("data", (c) => (s += c));
  req.on("end", () => ok(s));
  req.on("error", err);
});

const scanPayload = async () => {
  const snap = await getSnapshot();
  const opportunities = scanMarket(snap).sort((a, b) => b.netApr - a.netApr);
  return {
    asOf: snap.asOf,
    opportunities,
    snapshot: { lendingCount: snap.lending.length, perpCount: snap.perps.length, holdYields: snap.holdYields, errors: snap.errors },
    markets: { lending: snap.lending, perps: snap.perps.filter((p) => p.venue === "gmx-v2"), fixed: snap.fixed },
  };
};

export const serve = (port = Number(process.env.PORT ?? 8787)) => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    try {
      if (url.pathname === "/api/scan") return send(res, 200, await scanPayload());
      if (url.pathname === "/api/wallet") {
        const a = url.searchParams.get("address") ?? "";
        if (!isAddress(a)) return send(res, 400, { error: "address must be a 0x… Arbitrum address" });
        return send(res, 200, await walletReport(a as Address, await getSnapshot()));
      }
      if (url.pathname === "/api/plan" && req.method === "POST") {
        const { id, capitalUsd, account } = JSON.parse(await body(req)) as { id: string; capitalUsd: number; account?: string };
        const snap = await getSnapshot();
        const opp = scanMarket(snap, { minNetApr: -10, minCapacityUsd: 0 }).find((o) => o.id === id);
        if (!opp) return send(res, 404, { error: `opportunity ${id} not found in the current scan (rates move; rescan)` });
        const acct = (account && isAddress(account) ? account : "0x000000000000000000000000000000000000c0DE") as Address;
        return send(res, 200, await buildPlan(opp, Number(capitalUsd) || 10_000, acct, snap));
      }
      if (url.pathname === "/api/bot") return send(res, 200, await loadState());
      if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "unknown endpoint" });
      // Static dashboard.
      const rel = normalize(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
      if (rel.startsWith("..")) return send(res, 400, { error: "bad path" });
      const file = join(WEB, rel);
      const data = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(data);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return send(res, 404, { error: "not found" });
      send(res, 500, { error: err.message });
    }
  });
  server.listen(port, () => console.log(`Carry dashboard on http://localhost:${port}`));
  return server;
};
