// Carry dashboard. Plain ES module, no build step, no dependencies.
// Data comes from the local backend (/api/*) or, with ?demo=1, from ./fixtures/*.json.

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo") && params.get("demo") !== "0";

// ---------------------------------------------------------------- helpers

/** Tiny DOM builder. Strings become text nodes, so network data is never parsed as HTML. */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "dataset") Object.assign(node.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, String(v));
    }
  }
  append(node, children);
  return node;
}
function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
const $ = (sel) => document.querySelector(sel);

const MINUS = "−";
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

/** 0.1234 -> "12.34%" (unsigned, negatives keep a true minus sign). */
function pct(x, digits = 2) {
  if (!isNum(x)) return "—";
  const s = (Math.abs(x) * 100).toFixed(digits) + "%";
  return x < 0 && Number((Math.abs(x) * 100).toFixed(digits)) !== 0 ? MINUS + s : s;
}
/** 0.1234 -> "+12.34%", -0.031 -> "−3.10%". */
function spct(x, digits = 2) {
  if (!isNum(x)) return "—";
  const r = Number((x * 100).toFixed(digits));
  const s = Math.abs(r).toFixed(digits) + "%";
  if (r > 0) return "+" + s;
  if (r < 0) return MINUS + s;
  return s;
}
function signClass(x) { return !isNum(x) ? "" : x > 0.000005 ? "pos" : x < -0.000005 ? "neg" : "zero"; }

const compactFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const usdFmt0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdFmt2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Compact USD: 1_234_567 -> "$1.2M". */
function usdc(x) {
  if (!isNum(x)) return "—";
  const s = compactFmt.format(Math.abs(x));
  return x < 0 ? MINUS + s : s;
}
function usd(x, cents = false) {
  if (!isNum(x)) return "—";
  const s = (cents ? usdFmt2 : usdFmt0).format(Math.abs(x));
  return x < 0 ? MINUS + s : s;
}
function susd(x) {
  if (!isNum(x)) return "—";
  const s = usdFmt0.format(Math.abs(x));
  return x > 0.5 ? "+" + s : x < -0.5 ? MINUS + s : s;
}
function price(x) {
  if (!isNum(x)) return "—";
  const a = Math.abs(x);
  const digits = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return "$" + x.toLocaleString("en-US", { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits });
}
function num(x, digits = 2) {
  if (!isNum(x)) return "—";
  return x.toLocaleString("en-US", { maximumFractionDigits: digits });
}
function lev(x) { return isNum(x) ? x.toFixed(x >= 10 ? 0 : 1) + "×" : "—"; }
function shortAddr(a) { return typeof a === "string" && a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : String(a ?? "—"); }

function relTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  // Clamp small clock skew between the server and this browser to "just now".
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  const a = Math.abs(s);
  const f = (n, u) => `${n}${u} ${s >= 0 ? "ago" : "from now"}`;
  if (a < 10) return "just now";
  if (a < 60) return f(a, "s");
  if (a < 3600) return f(Math.round(a / 60), "m");
  if (a < 86400) return f(Math.round(a / 3600), "h");
  return f(Math.round(a / 86400), "d");
}
function clock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? "");
  return d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function signed(x, fmt = spct) { return el("span", { class: `num ${signClass(x)}` }, fmt(x)); }

function errorBox(msg, title = "Error") {
  return el("div", { class: "error-box", role: "alert" }, el("strong", null, title + ":"), el("span", null, String(msg)));
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const isAddress = (s) => /^0x[a-fA-F0-9]{40}$/.test(String(s || "").trim());

// ---------------------------------------------------------------- data layer

async function getJson(url, init) {
  let res;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch (e) {
    throw new Error(`Network error reaching ${url.split("?")[0]}: ${e.message || e}`);
  }
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (body && typeof body === "object" && typeof body.error === "string") throw new Error(body.error);
  if (!res.ok) {
    const snippet = text && !body && !/^\s*</.test(text) ? ": " + text.slice(0, 160) : "";
    const hint = res.status === 404 || res.status === 501 ? " (is the Carry backend running? Open with ?demo=1 for fixture data)" : "";
    throw new Error(`${res.status} ${res.statusText || "request failed"} from ${url.split("?")[0]}${snippet}${hint}`);
  }
  if (body == null) throw new Error("Empty or non-JSON response");
  return body;
}

const api = {
  scan: () => getJson(DEMO ? "./fixtures/scan.json" : "/api/scan"),
  bot: () => getJson(DEMO ? "./fixtures/bot.json" : "/api/bot"),
  wallet: (address) => DEMO
    ? getJson("./fixtures/wallet.json")
    : getJson(`/api/wallet?address=${encodeURIComponent(address)}`),
  plan: async (body, opp) => {
    if (DEMO) return demoPlan(body, opp);
    return getJson("/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  },
};

/** Demo mode has no backend: synthesize an ExecutionPlan-shaped object from the legs. */
function demoPlan({ id, capitalUsd, account }, opp) {
  const TO = {
    "aave-v3": "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    "compound-v3": "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf",
    "gmx-v2": "0x900173A66dbD345006C51fA35fA3aB760FcD843b",
    "uniswap-v3": "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    "pendle": "0x888888888889758F76e7103c6CbF23ABbF58F946",
  };
  const SEL = { supply: "0x617ba037", borrow: "0xa415bcad", repay: "0x573ade81", withdraw: "0x69328dec", swap: "0x04e45aaf", "short-perp": "0xac9650d8", "long-perp": "0xac9650d8", "close-perp": "0xac9650d8", "buy-pt": "0xc81f847a" };
  const pad = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const steps = [];
  for (const leg of opp?.legs || []) {
    if (leg.action === "hold") continue;
    const to = TO[leg.venue] || "0x0000000000000000000000000000000000000000";
    const amt = BigInt(Math.round((capitalUsd * Math.abs(leg.weight || 0)) * 1e6));
    if (["supply", "repay", "swap", "short-perp", "long-perp", "buy-pt"].includes(leg.action)) {
      steps.push({ label: `Approve ${leg.symbol.split("→")[0]} for ${leg.venue}`, to: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", data: "0x095ea7b3" + pad(to) + pad(amt.toString(16)), value: "0" });
    }
    const perp = leg.action.endsWith("-perp");
    steps.push({
      label: `${leg.action} ${leg.symbol} on ${leg.venue} (${num(Math.abs(leg.weight) * capitalUsd, 0)} USD notional)`,
      to,
      data: (SEL[leg.action] || "0x00000000") + pad(account) + pad(amt.toString(16)) + pad("1") + "0".repeat(perp ? 256 : 64),
      value: perp ? "310000000000000" : "0",
      expect: perp ? "Order keeper executes within ~2 blocks; position appears in Reader.getAccountPositions" : undefined,
    });
  }
  return { opportunityId: id, account, capitalUsd, steps, notes: ["Demo mode: calldata is synthesized locally and is NOT valid for submission.", "The real backend builds and simulates every step against Arbitrum."] };
}

// ---------------------------------------------------------------- state

const STRATEGIES = ["basis", "reverse-basis", "lend-borrow", "fx-carry", "lst-loop", "fixed-carry", "funding-spread", "wallet"];
const GRADES = ["A", "B", "C", "D"];

const state = {
  scan: null, scanError: null,
  bot: null, botError: null,
  wallet: null, walletError: null, walletLoading: false,
  filters: { strategies: new Set(), execOnly: false, minApr: 0, maxRisk: "D" },
  expanded: new Set(),
  plans: new Map(), // opp id -> { loading, plan, error, capital, account }
  perpSort: { key: "shortCarryApr", dir: "desc" },
  tab: "board",
};

// ---------------------------------------------------------------- header

function renderHeader() {
  $("#demo-badge").hidden = !DEMO;
  const f = $("#freshness");
  if (state.scan?.asOf) {
    f.textContent = `Data as of ${clock(state.scan.asOf)} · ${relTime(state.scan.asOf)}`;
    f.title = state.scan.asOf;
  } else if (state.scanError) {
    f.textContent = "Scan unavailable";
  }
  const errs = clear($("#source-errors"));
  const list = state.scan?.snapshot?.errors || [];
  if (list.length) {
    errs.append(el("span", { class: "pill pill-warn", title: list.join("\n"), tabindex: "0", "aria-label": `${list.length} data source error${list.length > 1 ? "s" : ""}: ${list.join("; ")}` },
      "⚠ ", `${list.length} source${list.length > 1 ? "s" : ""} degraded`));
  }
  if (state.scanError) errs.append(el("span", { class: "pill pill-err", title: state.scanError }, "✕ scan error"));

  const pill = $("#bot-pill");
  const b = state.bot;
  if (state.botError) {
    pill.className = "pill pill-err"; pill.textContent = "✕ Bot unreachable"; pill.title = state.botError;
  } else if (b) {
    const mode = String(b.mode || "off");
    const cls = !b.running || mode === "off" ? "pill-off" : mode === "live" ? "pill-live" : "pill-on";
    clear(pill); pill.className = "pill " + cls;
    pill.append(el("span", { class: "dot", "aria-hidden": "true" }), `Bot ${b.running ? "running" : "stopped"} · ${mode}`);
    pill.title = b.lastScanAt ? `Last bot scan ${relTime(b.lastScanAt)}` : "";
  }
}

// ---------------------------------------------------------------- board

function gradeRank(g) { const i = GRADES.indexOf(g); return i < 0 ? 3 : i; }

function filteredOpps() {
  const opps = Array.isArray(state.scan?.opportunities) ? state.scan.opportunities : [];
  const f = state.filters;
  return opps.filter((o) =>
    (f.strategies.size === 0 || f.strategies.has(o.strategy)) &&
    (!f.execOnly || o.executable) &&
    (!isNum(o.netApr) || o.netApr * 100 >= f.minApr) &&
    gradeRank(o.risk?.grade) <= gradeRank(f.maxRisk));
}

function renderStrategyChips() {
  const box = clear($("#strategy-chips"));
  const opps = state.scan?.opportunities || [];
  const counts = new Map();
  for (const o of opps) counts.set(o.strategy, (counts.get(o.strategy) || 0) + 1);
  const present = [...STRATEGIES.filter((s) => counts.has(s)), ...[...counts.keys()].filter((s) => !STRATEGIES.includes(s))];
  const allOn = state.filters.strategies.size === 0;
  box.append(el("button", { type: "button", class: "chip", "aria-pressed": String(allOn), onclick: () => { state.filters.strategies.clear(); renderBoard(); } },
    "all ", el("span", { class: "count" }, opps.length)));
  for (const s of present) {
    const on = state.filters.strategies.has(s);
    box.append(el("button", {
      type: "button", class: `chip chip-strategy chip-s-${s}`, "aria-pressed": String(on),
      onclick: () => { on ? state.filters.strategies.delete(s) : state.filters.strategies.add(s); renderBoard(); },
    }, s, " ", el("span", { class: "count" }, counts.get(s))));
  }
}

function kpi(label, value, sub, cls = "") {
  return el("div", { class: "kpi" }, el("div", { class: "kpi-label" }, label), el("div", { class: `kpi-value ${cls}` }, value), sub ? el("div", { class: "kpi-sub" }, sub) : null);
}

function renderBoardSummary() {
  const box = clear($("#board-summary"));
  const s = state.scan;
  if (!s) return;
  const opps = s.opportunities || [];
  const exec = opps.filter((o) => o.executable);
  const best = opps.reduce((a, o) => (isNum(o.netApr) && (!a || o.netApr > a.netApr) ? o : a), null);
  const bestExec = exec.reduce((a, o) => (isNum(o.netApr) && (!a || o.netApr > a.netApr) ? o : a), null);
  const cap = exec.reduce((sum, o) => sum + (isNum(o.capacityUsd) ? o.capacityUsd : 0), 0);
  box.append(
    kpi("Opportunities", `${opps.length}`, `${exec.length} executable`),
    kpi("Best net APR", best ? spct(best.netApr) : "—", best ? best.title : "", signClass(best?.netApr)),
    kpi("Best executable", bestExec ? spct(bestExec.netApr) : "—", bestExec ? bestExec.title : "", signClass(bestExec?.netApr)),
    kpi("Executable capacity", usdc(cap), `${s.snapshot?.lendingCount ?? s.markets?.lending?.length ?? "?"} lending · ${s.snapshot?.perpCount ?? s.markets?.perps?.length ?? "?"} perp markets`),
  );
}

function strategyChip(s) { return el("span", { class: `chip chip-strategy chip-s-${s}` }, s || "unknown"); }

function gradeEl(risk) {
  const g = GRADES.includes(risk?.grade) ? risk.grade : "?";
  return el("span", { class: `grade grade-${g}`, title: `Risk grade ${g}, score ${risk?.score ?? "?"} / 100 (0 = safest)` },
    el("span", { class: "grade-badge" }, g), el("span", { class: "grade-score" }, isNum(risk?.score) ? String(Math.round(risk.score)) : "—"));
}

function execBadge(o) {
  if (o.executable) return el("span", { class: "badge badge-exec" }, "✓ executable");
  const why = o.whyNotExecutable || "No transaction builder for one or more legs.";
  return el("span", { class: "badge badge-info", title: why, tabindex: "0", "aria-label": `Info only: ${why}` }, "ⓘ info only");
}

let uid = 0;
/** One opportunity card. Used by the board and by the wallet tab. */
function oppCard(o, idx) {
  const key = `${o.scope || "market"}:${o.id}`;
  const open = state.expanded.has(key);
  const detailId = `opp-d-${idx}-${++uid}`;
  const walletLine = o.walletImpact && isNum(o.walletImpact.usdPerYear)
    ? el("div", { class: "impact" }, `${susd(o.walletImpact.usdPerYear)}/yr on ${usd(o.walletImpact.amountUsd)}`)
    : null;

  const head = el("button", {
    type: "button", class: "opp-head", "aria-expanded": String(open), "aria-controls": detailId,
    onclick: () => { open ? state.expanded.delete(key) : state.expanded.add(key); rerenderCards(); },
  },
    el("div", { class: "opp-main" },
      el("div", { class: "opp-meta" }, strategyChip(o.strategy), o.scope === "wallet" ? el("span", { class: "chip" }, "your wallet") : null),
      el("div", { class: "opp-title" }, o.title || o.id),
      walletLine),
    el("div", { class: "opp-net", title: `Gross ${spct(o.grossApr)} − cost ${pct(o.costApr)} = net ${spct(o.netApr)}` },
      el("div", { class: `net-big ${signClass(o.netApr)}` }, spct(o.netApr)),
      el("div", { class: "net-sub" }, `gross ${spct(o.grossApr)} · cost ${pct(o.costApr)}`)),
    el("div", { class: "opp-lev" }, el("div", { class: "stat-label" }, "Leverage"), el("div", { class: "stat-val" }, lev(o.leverage))),
    el("div", { class: "opp-cap" }, el("div", { class: "stat-label" }, "Capacity"), el("div", { class: "stat-val" }, usdc(o.capacityUsd))),
    el("div", { class: "opp-risk" }, el("div", { class: "stat-label" }, "Risk"), gradeEl(o.risk)),
    el("div", { class: "opp-exec" }, execBadge(o)),
  );
  // SVG must be created in the SVG namespace.
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "icon opp-caret"); svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6 9l6 6 6-6"); svg.append(path);
  head.append(svg);

  const card = el("article", { class: `opp${open ? " open" : ""}` }, head);
  if (open) card.append(oppDetail(o, key, detailId));
  return card;
}

function legsTable(legs) {
  const rows = (legs || []).map((l) => el("tr", null,
    el("td", null, l.action),
    el("td", { class: "venue" }, l.venue),
    el("td", null, l.symbol, l.note ? el("span", { class: "tag-soft", title: l.note }, "note") : null),
    el("td", { class: "r" }, isNum(l.weight) ? l.weight.toFixed(2) + "×" : "—"),
    el("td", { class: "r" }, signed(l.apr)),
    el("td", { class: "r" }, signed(isNum(l.weight) && isNum(l.apr) ? l.weight * l.apr : null)),
  ));
  return el("div", { class: "table-wrap" }, el("table", { class: "data compact" },
    el("caption", { class: "sr-only", hidden: true }, "Trade legs"),
    el("thead", null, el("tr", null,
      el("th", { scope: "col" }, "Action"), el("th", { scope: "col" }, "Venue"), el("th", { scope: "col" }, "Symbol"),
      el("th", { scope: "col", class: "r" }, "Weight"), el("th", { scope: "col", class: "r" }, "Leg APR"), el("th", { scope: "col", class: "r" }, "On capital"))),
    el("tbody", null, rows.length ? rows : el("tr", null, el("td", { colspan: "6", class: "muted" }, "No legs")))));
}

function oppDetail(o, key, detailId) {
  const r = o.risk || {};
  const riskBits = [];
  if (isNum(r.healthFactor)) riskBits.push(el("span", null, "Health factor ", el("b", null, r.healthFactor.toFixed(2))));
  if (isNum(r.liquidationMovePct)) riskBits.push(el("span", null, "Liquidates on ", el("b", null, pct(r.liquidationMovePct, 1)), " adverse move"));
  const paramEntries = Object.entries(o.params || {});

  return el("div", { class: "opp-detail", id: detailId },
    el("div", { class: "detail-col" },
      el("p", { class: "thesis" }, o.thesis || ""),
      !o.executable ? el("div", { class: "not-exec" }, "Info only: ", o.whyNotExecutable || "no transaction builder for one or more legs.") : null,
      el("div", null, el("h3", null, "Legs"), el("div", { style: "height:8px" }), legsTable(o.legs)),
      el("div", null, el("h3", null, "Build plan"), el("div", { style: "height:8px" }), planBuilder(o, key)),
    ),
    el("div", { class: "detail-col" },
      el("div", null,
        el("h3", null, "Risk"), el("div", { style: "height:8px" }),
        el("div", { class: "risk-line" }, gradeEl(r), ...riskBits),
        (r.factors || []).length ? el("ul", { class: "factors", style: "margin-top:8px" }, r.factors.map((f) => el("li", null, f))) : null),
      paramEntries.length ? el("div", null, el("h3", null, "Params"), el("div", { style: "height:8px" }),
        el("dl", { class: "params" }, paramEntries.map(([k, v]) => [el("dt", null, k), el("dd", null, String(v))]))) : null,
      el("div", { class: "muted mono" }, "id: ", o.id),
    ),
  );
}

function planBuilder(o, key) {
  const st = state.plans.get(key) || {};
  const defAccount = st.account ?? state.wallet?.address ?? store.get("carry.wallet") ?? "";
  const defCap = st.capital ?? 10000;
  const capIn = el("input", { type: "number", min: "0", step: "any", value: String(defCap), required: true, inputmode: "decimal" });
  const accIn = el("input", { type: "text", value: defAccount, placeholder: "0x… account", spellcheck: "false", autocomplete: "off", required: true });
  const btn = el("button", { class: "btn btn-primary", type: "submit", disabled: st.loading || undefined }, st.loading ? "Building…" : "Build plan");
  const form = el("form", {
    class: "plan-form",
    onsubmit: async (e) => {
      e.preventDefault();
      const capitalUsd = Number(capIn.value);
      const account = accIn.value.trim();
      if (!(capitalUsd > 0)) { state.plans.set(key, { capital: capIn.value, account, error: "Capital must be a positive USD amount." }); rerenderCards(); return; }
      if (!isAddress(account)) { state.plans.set(key, { capital: capitalUsd, account, error: "Account must be a 0x-prefixed 40-hex-character address." }); rerenderCards(); return; }
      state.plans.set(key, { loading: true, capital: capitalUsd, account });
      rerenderCards();
      try {
        const plan = await api.plan({ id: o.id, capitalUsd, account }, o);
        state.plans.set(key, { plan, capital: capitalUsd, account });
      } catch (err) {
        state.plans.set(key, { error: err.message || String(err), capital: capitalUsd, account });
      }
      rerenderCards();
    },
  },
    el("label", null, "Capital (USD)", capIn),
    el("label", null, "Account", accIn),
    btn,
  );
  return el("div", { style: "display:flex;flex-direction:column;gap:10px" },
    form,
    st.error ? errorBox(st.error, "Plan failed") : null,
    st.plan ? planView(st.plan) : null);
}

function copyText(text) {
  const done = () => toast("Copied to clipboard");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = el("textarea", { style: "position:fixed;opacity:0" });
  ta.value = text; document.body.append(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch { toast("Copy failed"); }
  ta.remove();
}

function weiLabel(v) {
  try {
    const b = BigInt(String(v ?? "0"));
    if (b === 0n) return "0";
    const eth = Number(b) / 1e18;
    return `${b.toString()} wei (${eth.toPrecision(3)} ETH)`;
  } catch { return String(v); }
}

function planView(plan) {
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  return el("div", { style: "display:flex;flex-direction:column;gap:10px" },
    el("div", { class: "muted" }, `${steps.length} transaction${steps.length === 1 ? "" : "s"} for ${usd(plan.capitalUsd)} from ${shortAddr(plan.account)}`),
    el("ol", { class: "steps" }, steps.map((s) => el("li", { class: "step" },
      el("div", { class: "step-head" }, el("span", { class: "step-label" }, s.label || "step")),
      el("div", { class: "step-meta" },
        el("span", null, "to ", isAddress(s.to)
          ? el("a", { class: "mono", href: `https://arbiscan.io/address/${s.to}`, target: "_blank", rel: "noopener noreferrer", title: s.to }, shortAddr(s.to))
          : el("span", { class: "mono" }, String(s.to))),
        el("span", null, "value ", el("span", { class: "mono" }, weiLabel(s.value)))),
      s.expect ? el("div", { class: "step-expect" }, "Expect: ", s.expect) : null,
      el("details", null,
        el("summary", null, `calldata · ${Math.max(0, ((s.data || "").length - 2) / 2)} bytes`,
          el("button", { type: "button", class: "btn btn-sm", onclick: (e) => { e.preventDefault(); copyText(s.data || ""); } }, "Copy")),
        el("pre", { class: "calldata" }, s.data || "0x")),
    ))),
    (plan.notes || []).length ? el("ul", { class: "notes" }, plan.notes.map((n) => el("li", null, n))) : null,
  );
}

function renderBoard() {
  renderStrategyChips();
  renderBoardSummary();
  const errBox = clear($("#board-error"));
  if (state.scanError) errBox.append(errorBox(state.scanError, "Scan failed"));
  const box = clear($("#board"));
  if (!state.scan) {
    if (!state.scanError) for (let i = 0; i < 4; i++) box.append(el("div", { class: "skeleton" }));
    return;
  }
  const list = filteredOpps();
  if (!list.length) {
    box.append(el("div", { class: "empty" }, (state.scan.opportunities || []).length ? "No opportunities match these filters." : "The scan returned no opportunities."));
    return;
  }
  list.forEach((o, i) => box.append(oppCard(o, i)));
}

function rerenderCards() {
  if (state.tab === "wallet") renderWallet(); else renderBoard();
}

// ---------------------------------------------------------------- markets

function th(label, cls) { return el("th", { scope: "col", class: cls }, label); }

const PERP_COLS = [
  { key: "venue", label: "Venue", get: (p) => p.venue },
  { key: "name", label: "Market", get: (p) => p.name },
  { key: "markPx", label: "Mark", get: (p) => p.markPx, r: true, fmt: (v) => price(v) },
  { key: "longCarryApr", label: "Long carry", get: (p) => p.longCarryApr, r: true, signed: true },
  { key: "shortCarryApr", label: "Short carry", get: (p) => p.shortCarryApr, r: true, signed: true },
  { key: "openInterestLongUsd", label: "OI long", get: (p) => p.openInterestLongUsd, r: true, fmt: usdc },
  { key: "openInterestShortUsd", label: "OI short", get: (p) => p.openInterestShortUsd, r: true, fmt: usdc },
  { key: "availableShortUsd", label: "Avail. short", get: (p) => p.availableShortUsd, r: true, fmt: usdc },
];

function renderPerps(perps) {
  const t = clear($("#t-perps"));
  const { key, dir } = state.perpSort;
  const col = PERP_COLS.find((c) => c.key === key) || PERP_COLS[4];
  const sorted = [...perps].sort((a, b) => {
    const x = col.get(a), y = col.get(b);
    let c;
    if (typeof x === "number" || typeof y === "number") c = (isNum(x) ? x : -Infinity) - (isNum(y) ? y : -Infinity);
    else c = String(x ?? "").localeCompare(String(y ?? ""));
    return dir === "asc" ? c : -c;
  });
  t.append(el("thead", null, el("tr", null, PERP_COLS.map((c) => {
    const active = c.key === key;
    return el("th", { scope: "col", class: c.r ? "r" : null, "aria-sort": active ? (dir === "asc" ? "ascending" : "descending") : null },
      el("button", {
        type: "button", class: "sort",
        onclick: () => {
          state.perpSort = { key: c.key, dir: active && dir === "desc" ? "asc" : active ? "desc" : c.r ? "desc" : "asc" };
          renderPerps(perps);
        },
      }, c.label, el("span", { class: "arrow", "aria-hidden": "true" }, active ? (dir === "asc" ? "▲" : "▼") : "↕")));
  }))));
  t.append(el("tbody", null, sorted.length ? sorted.map((p) => el("tr", null, PERP_COLS.map((c) => {
    const v = c.get(p);
    if (c.signed) return el("td", { class: "r" }, signed(v));
    if (c.key === "venue") return el("td", { class: "venue" }, v, !p.executable ? el("span", { class: "tag-soft", title: "No transaction builder for this venue" }, "info") : null);
    return el("td", { class: c.r ? "r" : null }, c.fmt ? c.fmt(v) : v ?? "—");
  }))) : el("tr", null, el("td", { colspan: String(PERP_COLS.length), class: "muted" }, "No perp markets"))));
}

function renderLending(rows) {
  const t = clear($("#t-lending"));
  const sorted = [...rows].sort((a, b) => (b.supplyApr ?? 0) - (a.supplyApr ?? 0));
  t.append(el("thead", null, el("tr", null, th("Venue"), th("Symbol"), th("Supply APR", "r"), th("Borrow APR", "r"), th("LTV", "r"), th("Available", "r"), th("Source"))));
  t.append(el("tbody", null, sorted.length ? sorted.map((m) => el("tr", null,
    el("td", { class: "venue" }, m.venue, !m.executable ? el("span", { class: "tag-soft", title: "No transaction builder for this venue" }, "info") : null),
    el("td", null, m.symbol, isNum(m.rewardApr) && m.rewardApr > 0 ? el("span", { class: "tag-soft", title: `Incentives ${pct(m.rewardApr)} not counted in carry` }, `+${pct(m.rewardApr)} rwd`) : null),
    el("td", { class: "r" }, signed(m.supplyApr)),
    el("td", { class: "r" }, m.borrowApr == null ? el("span", { class: "muted" }, "n/a") : signed(-m.borrowApr)),
    el("td", { class: "r" }, m.ltv > 0 ? pct(m.ltv, 0) : "—"),
    el("td", { class: "r" }, usdc(m.availableUsd)),
    el("td", null, el("span", { class: "src" }, m.source)),
  )) : el("tr", null, el("td", { colspan: "7", class: "muted" }, "No lending markets"))));
}

function renderFixed(rows) {
  const t = clear($("#t-fixed"));
  const sorted = [...rows].sort((a, b) => (b.impliedApr ?? 0) - (a.impliedApr ?? 0));
  t.append(el("thead", null, el("tr", null, th("Market"), th("Implied APR", "r"), th("Underlying APR", "r"), th("Spread", "r"), th("Days to expiry", "r"), th("Liquidity", "r"))));
  t.append(el("tbody", null, sorted.length ? sorted.map((m) => el("tr", null,
    el("td", null, isAddress(m.market) ? el("a", { href: `https://arbiscan.io/address/${m.market}`, target: "_blank", rel: "noopener noreferrer" }, m.name) : m.name),
    el("td", { class: "r" }, signed(m.impliedApr)),
    el("td", { class: "r" }, signed(m.underlyingApr)),
    el("td", { class: "r" }, signed(isNum(m.impliedApr) && isNum(m.underlyingApr) ? m.impliedApr - m.underlyingApr : null)),
    el("td", { class: "r" }, isNum(m.daysToExpiry) ? Math.round(m.daysToExpiry) + "d" : "—"),
    el("td", { class: "r" }, usdc(m.liquidityUsd)),
  )) : el("tr", null, el("td", { colspan: "6", class: "muted" }, "No fixed-yield markets"))));
}

function renderHold(rows) {
  $("#hold-yields-block").hidden = !rows.length;
  const t = clear($("#t-hold"));
  t.append(el("thead", null, el("tr", null, th("Asset"), th("APR", "r"), th("Source"), th("Note"))));
  t.append(el("tbody", null, rows.map((h) => el("tr", null,
    el("td", null, h.symbol), el("td", { class: "r" }, signed(h.apr)), el("td", null, el("span", { class: "src" }, h.source)), el("td", { class: "muted" }, h.note || "")))));
}

function renderCurve(perps) {
  const box = clear($("#curve"));
  if (!perps.length) { box.append(el("div", { class: "empty" }, "No perp data")); return; }
  const topShort = [...perps].filter((p) => isNum(p.shortCarryApr)).sort((a, b) => b.shortCarryApr - a.shortCarryApr).slice(0, 15);
  const topLong = [...perps].filter((p) => isNum(p.longCarryApr)).sort((a, b) => b.longCarryApr - a.longCarryApr).slice(0, 15);
  const maxAbs = Math.max(0.0001, ...topShort.map((p) => Math.abs(p.shortCarryApr)), ...topLong.map((p) => Math.abs(p.longCarryApr)));
  const col = (title, list, field) => el("div", { class: "curve-col" },
    el("h3", null, title),
    el("div", { role: "list" }, list.map((p) => {
      const v = p[field];
      const w = Math.min(50, (Math.abs(v) / maxAbs) * 50);
      return el("div", { class: "bar-row", role: "listitem", title: `${p.venue} ${p.name}: ${spct(v)}` },
        el("span", { class: "bar-name" }, p.name, el("span", { class: "v" }, p.venue)),
        el("span", { class: "bar-track", "aria-hidden": "true" }, el("span", { class: `bar ${v >= 0 ? "pos" : "neg"}`, style: `width:${w.toFixed(2)}%` })),
        el("span", { class: `bar-val ${signClass(v)}` }, spct(v, 1)));
    })));
  box.append(col("Short carry (shorts receive →)", topShort, "shortCarryApr"), col("Long carry (longs receive →)", topLong, "longCarryApr"));
}

function renderMarkets() {
  const err = clear($("#markets-error"));
  if (state.scanError) err.append(errorBox(state.scanError, "Scan failed"));
  const m = state.scan?.markets || {};
  const perps = Array.isArray(m.perps) ? m.perps : [];
  renderCurve(perps);
  renderPerps(perps);
  renderLending(Array.isArray(m.lending) ? m.lending : []);
  renderFixed(Array.isArray(m.fixed) ? m.fixed : []);
  renderHold(Array.isArray(state.scan?.snapshot?.holdYields) ? state.scan.snapshot.holdYields : []);
}

// ---------------------------------------------------------------- wallet

function healthGauge(hf) {
  // Map HF 1.0..3.0 onto the track; values beyond clamp.
  const lo = 1, hi = 3;
  const pos = Math.max(0, Math.min(1, (hf - lo) / (hi - lo))) * 100;
  const label = hf < 1.1 ? "at risk" : hf < 1.5 ? "tight" : hf < 2 ? "moderate" : "comfortable";
  return el("div", { class: "gauge", role: "meter", "aria-valuemin": "1", "aria-valuemax": "3", "aria-valuenow": String(hf), "aria-label": `Aave health factor ${hf.toFixed(2)}, ${label}` },
    el("div", { class: "gauge-track" }, el("span", { class: "gauge-mark", style: `left:${pos.toFixed(1)}%` })),
    el("div", { class: "gauge-scale", "aria-hidden": "true" }, el("span", null, "1.0 liq"), el("span", null, "1.5"), el("span", null, "2.0"), el("span", null, "2.5"), el("span", null, "3.0+")));
}

function renderWallet() {
  const out = clear($("#wallet-out"));
  if (state.walletLoading) { out.append(el("div", { class: "skeleton" }), el("div", { class: "skeleton" })); return; }
  if (state.walletError) out.append(errorBox(state.walletError, "Wallet scan failed"));
  const w = state.wallet;
  if (!w) {
    if (!state.walletError) out.append(el("div", { class: "empty" }, "Enter an Arbitrum address to see its current carry and what it could earn."));
    return;
  }
  const uplift = (w.potentialCarryUsdPerYear ?? 0) - (w.currentCarryUsdPerYear ?? 0);
  const kpis = el("div", { class: "kpis" },
    kpi("Net worth", usd(w.netWorthUsd), `${shortAddr(w.address)} · ${relTime(w.asOf)}`),
    kpi("Current carry", `${susd(w.currentCarryUsdPerYear)}/yr`, `${spct(w.currentCarryApr)} on net worth`, signClass(w.currentCarryUsdPerYear)),
    kpi("Potential carry", `${susd(w.potentialCarryUsdPerYear)}/yr`, isNum(uplift) ? `${susd(uplift)}/yr uplift` : "", signClass(w.potentialCarryUsdPerYear)),
  );
  if (w.aave && isNum(w.aave.healthFactor)) {
    const hf = w.aave.healthFactor;
    kpis.append(el("div", { class: "kpi" },
      el("div", { class: "kpi-label" }, "Aave health factor"),
      el("div", { class: `kpi-value ${hf < 1.2 ? "neg" : hf < 1.5 ? "" : "pos"}` }, hf > 100 ? "∞" : hf.toFixed(2)),
      healthGauge(hf),
      el("div", { class: "kpi-sub" }, `${usdc(w.aave.collateralUsd)} collateral · ${usdc(w.aave.debtUsd)} debt${w.aave.eMode ? ` · e-mode ${w.aave.eMode}` : ""}`)));
  }
  out.append(kpis);

  const pos = Array.isArray(w.positions) ? w.positions : [];
  out.append(el("div", { class: "card-block" },
    el("div", { class: "block-head" }, el("h2", null, "Positions"), el("p", { class: "muted" }, `${pos.length} position${pos.length === 1 ? "" : "s"}`)),
    el("div", { class: "table-wrap" }, el("table", { class: "data" },
      el("thead", null, el("tr", null, th("Venue"), th("Kind"), th("Symbol"), th("Amount", "r"), th("USD", "r"), th("Carry APR", "r"), th("Carry $/yr", "r"), th("Detail"))),
      el("tbody", null, pos.length ? pos.map((p) => el("tr", null,
        el("td", { class: "venue" }, p.venue), el("td", null, p.kind), el("td", null, p.symbol),
        el("td", { class: "r" }, num(p.amount, 4)), el("td", { class: "r" }, usd(p.usd)),
        el("td", { class: "r" }, signed(p.apr)),
        el("td", { class: "r" }, signed(isNum(p.usd) && isNum(p.apr) ? Math.abs(p.usd) * p.apr : null, susd)),
        el("td", { class: "muted" }, p.detail ? Object.entries(p.detail).map(([k, v]) => `${k}: ${v}`).join(" · ") : ""),
      )) : el("tr", null, el("td", { colspan: "8", class: "muted" }, "No positions found")))))));

  const opps = Array.isArray(w.opportunities) ? w.opportunities : [];
  const list = el("div", { class: "cards" });
  opps.forEach((o, i) => list.append(oppCard(o, 1000 + i)));
  out.append(el("div", { class: "block-head", style: "margin:4px 0 -6px" }, el("h2", null, "Wallet opportunities"), el("p", { class: "muted" }, "Actions specific to this wallet, ranked by net APR.")),
    opps.length ? list : el("div", { class: "empty" }, "Nothing to improve right now."));
}

async function loadWallet(address) {
  state.walletLoading = true; state.walletError = null; renderWallet();
  try {
    state.wallet = await api.wallet(address);
    if (DEMO && !isAddress(address) && state.wallet?.address) $("#wallet-addr").value = state.wallet.address;
  } catch (e) {
    state.wallet = null; state.walletError = e.message || String(e);
  }
  state.walletLoading = false;
  renderWallet();
}

// ---------------------------------------------------------------- bot

function renderBot() {
  const out = clear($("#bot-out"));
  if (state.botError) out.append(errorBox(state.botError, "Bot status unavailable"));
  const b = state.bot;
  if (!b) { if (!state.botError) out.append(el("div", { class: "skeleton" })); return; }
  const positions = Array.isArray(b.positions) ? b.positions : [];
  const open = positions.filter((p) => p.status === "open");
  const deployed = open.reduce((s, p) => s + (isNum(p.capitalUsd) ? p.capitalUsd : 0), 0);
  const blended = deployed ? open.reduce((s, p) => s + (p.capitalUsd || 0) * (isNum(p.currentNetApr) ? p.currentNetApr : p.entryNetApr || 0), 0) / deployed : null;
  out.append(el("div", { class: "kpis" },
    kpi("Mode", String(b.mode || "off"), b.mode === "live" ? "Signs and sends real transactions" : b.mode === "fork" ? "Executes against a local fork" : b.mode === "dry-run" ? "Plans only, sends nothing" : "Idle", b.mode === "live" ? "neg" : ""),
    kpi("Status", b.running ? "● running" : "○ stopped", b.lastScanAt ? `last scan ${relTime(b.lastScanAt)}` : "no scan yet", b.running ? "pos" : ""),
    kpi("Open positions", String(open.length), `${usd(deployed)} deployed`),
    kpi("Blended net APR", blended == null ? "—" : spct(blended), blended == null ? "" : `${susd(deployed * blended)}/yr`, signClass(blended)),
  ));

  out.append(el("div", { class: "card-block" },
    el("div", { class: "block-head" }, el("h2", null, "Positions")),
    el("div", { class: "table-wrap" }, el("table", { class: "data" },
      el("thead", null, el("tr", null, th("Status"), th("Strategy"), th("Position"), th("Opened"), th("Capital", "r"), th("Entry APR", "r"), th("Current APR", "r"), th("Txs", "r"))),
      el("tbody", null, positions.length ? positions.map((p) => el("tr", null,
        el("td", null, el("span", { class: `pill ${p.status === "open" ? "pill-on" : p.status === "unwinding" ? "pill-warn" : "pill-off"}` }, el("span", { class: "dot", "aria-hidden": "true" }), p.status)),
        el("td", null, strategyChip(p.strategy)),
        el("td", { title: p.opportunityId }, p.title || p.opportunityId),
        el("td", { class: "num", title: p.openedAt }, relTime(p.openedAt)),
        el("td", { class: "r" }, usd(p.capitalUsd)),
        el("td", { class: "r" }, signed(p.entryNetApr)),
        el("td", { class: "r" }, signed(p.currentNetApr)),
        el("td", { class: "r" }, (p.txs || []).length
          ? el("span", null, (p.txs || []).map((h, i) => [i ? " " : "", el("a", { class: "mono", href: `https://arbiscan.io/tx/${h}`, target: "_blank", rel: "noopener noreferrer", title: h }, shortAddr(h))]))
          : el("span", { class: "muted" }, "—")),
      )) : el("tr", null, el("td", { colspan: "8", class: "muted" }, "No positions yet")))))));

  const log = Array.isArray(b.log) ? b.log : [];
  const logBox = el("div", { class: "log", role: "log", "aria-live": "polite", tabindex: "0", "aria-label": "Bot log" },
    log.length ? log.map((l) => el("div", { class: `log-line log-${l.level}` },
      el("span", { class: "log-at", title: l.at }, clock(l.at)),
      el("span", { class: "log-lvl" }, l.level),
      el("span", { class: "log-msg" }, l.msg))) : el("div", { class: "muted", style: "padding:8px 12px" }, "Log is empty"));
  out.append(el("div", { class: "card-block" }, el("div", { class: "block-head" }, el("h2", null, "Log"), el("p", { class: "muted" }, `${log.length} entries`)), logBox));
  requestAnimationFrame(() => { logBox.scrollTop = logBox.scrollHeight; });
}

// ---------------------------------------------------------------- tabs & wiring

const TABS = ["board", "markets", "wallet", "bot"];
function selectTab(name, focus = false) {
  if (!TABS.includes(name)) name = "board";
  state.tab = name;
  for (const t of TABS) {
    const btn = $(`#tab-${t}`), panel = $(`#panel-${t}`);
    const on = t === name;
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
    panel.hidden = !on;
    if (on && focus) btn.focus();
  }
  try { history.replaceState(null, "", `${location.pathname}${location.search}#${name}`); } catch { /* ignore */ }
  renderTab();
  if (name === "wallet" && !state.wallet && !state.walletLoading && !state.walletError) {
    const addr = $("#wallet-addr").value.trim();
    if (DEMO || isAddress(addr)) loadWallet(addr);
  }
}
function renderTab() {
  if (state.tab === "board") renderBoard();
  else if (state.tab === "markets") renderMarkets();
  else if (state.tab === "wallet") renderWallet();
  else if (state.tab === "bot") renderBot();
}

async function refresh() {
  const btn = $("#refresh");
  btn.disabled = true; btn.classList.add("spinning");
  const [scan, bot] = await Promise.allSettled([api.scan(), api.bot()]);
  if (scan.status === "fulfilled") { state.scan = scan.value; state.scanError = null; }
  else state.scanError = scan.reason?.message || String(scan.reason);
  if (bot.status === "fulfilled") { state.bot = bot.value; state.botError = null; }
  else state.botError = bot.reason?.message || String(bot.reason);
  btn.disabled = false; btn.classList.remove("spinning");
  renderHeader();
  renderTab();
}

async function refreshBot() {
  try { state.bot = await api.bot(); state.botError = null; }
  catch (e) { state.botError = e.message || String(e); }
  renderHeader();
  if (state.tab === "bot") renderBot();
}

function init() {
  // Tabs: click + arrow-key roving focus.
  const tablist = $(".tabs");
  tablist.addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) selectTab(b.dataset.tab); });
  tablist.addEventListener("keydown", (e) => {
    const i = TABS.indexOf(state.tab);
    if (e.key === "ArrowRight") { e.preventDefault(); selectTab(TABS[(i + 1) % TABS.length], true); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); selectTab(TABS[(i + TABS.length - 1) % TABS.length], true); }
    else if (e.key === "Home") { e.preventDefault(); selectTab(TABS[0], true); }
    else if (e.key === "End") { e.preventDefault(); selectTab(TABS[TABS.length - 1], true); }
  });

  $("#refresh").addEventListener("click", () => { refresh(); if (state.tab === "wallet" && (state.wallet || DEMO)) loadWallet($("#wallet-addr").value.trim()); });

  // Filters
  $("#f-exec").addEventListener("change", (e) => { state.filters.execOnly = e.target.checked; renderBoard(); });
  const range = $("#f-minapr"), out = $("#f-minapr-out");
  const syncRange = () => { state.filters.minApr = Number(range.value); out.textContent = (state.filters.minApr > 0 ? "+" : state.filters.minApr < 0 ? MINUS : "") + Math.abs(state.filters.minApr).toFixed(1) + "%"; };
  range.addEventListener("input", () => { syncRange(); renderBoard(); });
  syncRange();
  $("#f-maxrisk").addEventListener("change", (e) => { state.filters.maxRisk = e.target.value; renderBoard(); });

  // Wallet
  const addrIn = $("#wallet-addr");
  addrIn.value = store.get("carry.wallet") || "";
  $("#wallet-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const a = addrIn.value.trim();
    if (!DEMO && !isAddress(a)) { state.wallet = null; state.walletError = "Enter a valid address: 0x followed by 40 hex characters."; renderWallet(); return; }
    if (isAddress(a)) store.set("carry.wallet", a);
    loadWallet(a);
  });
  if (DEMO) addrIn.removeAttribute("pattern");

  const initial = (location.hash || "").slice(1);
  selectTab(TABS.includes(initial) ? initial : "board");
  renderHeader();
  refresh();

  // Keep relative times fresh; poll the bot while the page is visible.
  setInterval(() => { renderHeader(); }, 15000);
  setInterval(() => { if (!document.hidden) refreshBot(); }, 30000);
}

init();
