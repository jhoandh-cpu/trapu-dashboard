// Trap University — Dashboard de proyección de ventas (app alojada)
// Datos directos de WooCommerce (ventas exactas) + Klaviyo (checkout) + GA4 (tráfico).
// Sirve el dashboard en / y publica un resumen a Slack 2x/día (npm run slack).
import express from "express";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const TZ = process.env.STORE_TZ || "America/Los_Angeles"; // tienda en California (Pacífico)

// ----------------- PARÁMETROS DEL MODELO (histórico 2026 YTD) -----------------
const P = {
  aov: 70.07, daily_goal: Number(process.env.DAILY_GOAL || 1000),
  monthly_avg_rev: 30935, overall_daily_rev: 1046.3, overall_daily_ord: 14.93,
  users_factor: 0.87,
  bench: { sess: 497, cart: 142, ck: 55, ord: 15 },
  dowES: ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"],
  orders_by_dow: [14.97, 15.72, 14.43, 16.13, 16.53, 13.84, 13.03],
  revenue_by_dow: [1032.54, 1145.91, 1062.86, 1144.25, 1105.65, 948.01, 896.70],
  sessions_by_dow_median: [541, 515, 528.5, 544, 513, 463, 450],
  conversion_by_dow: [0.0277, 0.0305, 0.0273, 0.0297, 0.0322, 0.0299, 0.0290],
  wk_factor: [0.987, 1.095, 1.016, 1.094, 1.057, 0.906, 0.857],
  dom_factor: [0.773, 1.052, 0.725, 0.794, 0.859, 0.796, 0.872, 1.068, 1.034, 0.757, 0.734, 0.814, 1.047, 1.071, 1.386, 1.266, 0.871, 0.935, 1.037, 1.02, 1.041, 1.085, 0.999, 1.2, 1.047, 1.137, 1.262, 0.856, 1.307, 1.06, 1.27],
  // Curva intradía de órdenes verificada en HORA PACÍFICO (cuándo entra la venta)
  ord_cum: [0.036, 0.078, 0.102, 0.123, 0.129, 0.138, 0.144, 0.168, 0.186, 0.210, 0.263, 0.317, 0.377, 0.410, 0.461, 0.515, 0.554, 0.641, 0.719, 0.778, 0.829, 0.877, 0.943, 1.0],
  sess_cum: [0.0247, 0.0473, 0.0671, 0.089, 0.1125, 0.1419, 0.1759, 0.216, 0.2586, 0.3056, 0.3569, 0.4116, 0.4698, 0.5281, 0.5823, 0.6361, 0.6901, 0.7449, 0.7975, 0.8471, 0.8917, 0.9305, 0.9676, 1.0]
};

// ----------------- UTILIDADES -----------------
function nowStore() {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" });
  const p = {}; f.formatToParts(new Date()).forEach(x => p[x.type] = x.value);
  let hh = parseInt(p.hour); if (hh === 24) hh = 0;
  const wk = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return { y: +p.year, m: +p.month, d: +p.day, hour: hh, min: +p.minute, dow: wk[p.weekday], dateStr: `${p.year}-${p.month}-${p.day}`, hourFloat: hh + (+p.minute) / 60 };
}
function completed(cum, t) { if (t <= 0) return 0; if (t >= 24) return 1; const h = Math.floor(t); const base = h === 0 ? 0 : cum[h - 1]; const share = cum[h] - (h === 0 ? 0 : cum[h - 1]); return base + share * (t - h); }
function dowMon(y, m, d) { return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; }
function monthStartStr(et) { return `${et.y}-${String(et.m).padStart(2, "0")}-01`; }

// ----------------- CONECTORES DE DATOS -----------------
// WooCommerce: ventas EXACTAS (mismas que el admin). Reports/sales, hora local de la tienda.
async function wooSales(dateMin, dateMax) {
  const url = process.env.WOO_URL, ck = process.env.WOO_KEY, cs = process.env.WOO_SECRET;
  if (!url || !ck || !cs) return null;
  const auth = Buffer.from(`${ck}:${cs}`).toString("base64");
  const endpoint = `${url.replace(/\/$/, "")}/wp-json/wc/v3/reports/sales?date_min=${dateMin}&date_max=${dateMax}`;
  const r = await fetch(endpoint, { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok) throw new Error(`WooCommerce ${r.status}`);
  const j = await r.json();
  const row = Array.isArray(j) ? j[0] : j;
  if (!row) return null;
  return {
    total_sales: Number(row.total_sales || 0),   // bruto (lo que suele mostrar "Total sales")
    net_sales: Number(row.net_sales || 0),
    orders: Number(row.total_orders || 0),
    refunds: Number(row.total_refunds || 0)
  };
}

// Klaviyo: métricas de la tienda. PLACED_ORDER da ventas/órdenes (aprox), ThCWbv el checkout.
const KL_PLACED = "XvvKP6";
async function klaviyoAgg(metricId, measurements, startISO, endISO) {
  const key = process.env.KLAVIYO_API_KEY;
  if (!key) return null;
  const r = await fetch("https://a.klaviyo.com/api/metric-aggregates/", {
    method: "POST",
    headers: { Authorization: `Klaviyo-API-Key ${key}`, "Content-Type": "application/json", accept: "application/json", revision: "2024-10-15" },
    body: JSON.stringify({ data: { type: "metric-aggregate", attributes: { metric_id: metricId, measurements, interval: "day", timezone: TZ, filter: [`greater-or-equal(datetime,${startISO})`, `less-than(datetime,${endISO})`] } } })
  });
  if (!r.ok) throw new Error(`Klaviyo ${r.status}`);
  const j = await r.json();
  const meas = j?.data?.attributes?.data?.[0]?.measurements || {};
  const out = {};
  for (const m of measurements) out[m] = (meas[m] || []).reduce((a, b) => a + (b || 0), 0);
  return out;
}
async function klaviyoCount(metricId, startISO, endISO) {
  const o = await klaviyoAgg(metricId, ["count"], startISO, endISO);
  return o ? o.count : null;
}

// GA4: opcional (tráfico/conversión/funnel). Auth con service account (JWT RS256).
async function gaAccessToken() {
  const raw = process.env.GA_SA_JSON;
  if (!raw) return null;
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claim = Buffer.from(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })).toString("base64url");
  const sig = crypto.createSign("RSA-SHA256").update(`${header}.${claim}`).sign(sa.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${header}.${claim}.${sig}` });
  const j = await r.json();
  return j.access_token || null;
}
async function gaReport(metrics, startDate, endDate) {
  const prop = process.env.GA_PROPERTY_ID; if (!prop) return null;
  const token = await gaAccessToken(); if (!token) return null;
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runReport`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ dateRanges: [{ startDate, endDate }], metrics: metrics.map(m => ({ name: m })) })
  });
  if (!r.ok) throw new Error(`GA4 ${r.status}`);
  const j = await r.json();
  const vals = j?.rows?.[0]?.metricValues?.map(v => Number(v.value)) || metrics.map(() => 0);
  return Object.fromEntries(metrics.map((m, i) => [m, vals[i]]));
}

// ----------------- CÁLCULO DE LA PROYECCIÓN -----------------
async function computeSnapshot() {
  const et = nowStore();
  const pOrd = completed(P.ord_cum, et.hourFloat);
  const monthStart = monthStartStr(et);
  const src = {};
  // WooCommerce (exacto)
  let woToday = null, woMTD = null;
  try { woToday = await wooSales(et.dateStr, et.dateStr); src.woo = !!woToday; } catch (e) { src.wooErr = e.message; }
  try { woMTD = await wooSales(monthStart, et.dateStr); } catch (e) {}
  let revToday = woToday ? woToday.total_sales : 0;
  let ordToday = woToday ? woToday.orders : 0;
  let mtdRev = woMTD ? woMTD.total_sales : revToday;
  let mtdOrd = woMTD ? woMTD.orders : ordToday;
  // Si no hay WooCommerce, usar Klaviyo (Placed Order) como fuente de ventas (aprox, en vivo)
  if (!woToday) {
    try {
      const kT = await klaviyoAgg(KL_PLACED, ["count", "sum_value"], `${et.dateStr}T00:00:00`, `${nextDay(et)}T00:00:00`);
      const kM = await klaviyoAgg(KL_PLACED, ["count", "sum_value"], `${monthStart}T00:00:00`, `${nextDay(et)}T00:00:00`);
      if (kT) { revToday = kT.sum_value; ordToday = kT.count; src.sales = "klaviyo"; }
      if (kM) { mtdRev = kM.sum_value; mtdOrd = kM.count; }
    } catch (e) { src.klSalesErr = e.message; }
  } else { src.sales = "woo"; }

  // Klaviyo checkout (opcional)
  let ckToday = null;
  try { ckToday = await klaviyoCount("ThCWbv", `${et.dateStr}T00:00:00`, `${nextDay(et)}T00:00:00`); if (ckToday != null) src.klaviyo = true; } catch (e) { src.klaviyoErr = e.message; }

  // GA (opcional)
  let ga = null, projSess = null, projCart = null;
  try {
    const g = await gaReport(["sessions", "addToCarts"], et.dateStr, et.dateStr);
    if (g) { ga = g; src.ga = true; const pS = Math.max(completed(P.sess_cum, et.hourFloat), 0.05); projSess = g.sessions / pS; projCart = g.addToCarts / pS; }
  } catch (e) { src.gaErr = e.message; }

  // Proyección del día
  const A_rev = revToday / Math.max(pOrd, 0.03);
  const A_ord = ordToday / Math.max(pOrd, 0.03);
  const B_ord = projSess != null ? projSess * P.conversion_by_dow[et.dow] : null;
  const expOrd = P.overall_daily_ord * P.wk_factor[et.dow] * P.dom_factor[et.d - 1];
  const expRev = P.overall_daily_rev * P.wk_factor[et.dow] * P.dom_factor[et.d - 1];
  const w = Math.max(0.15, Math.min(1, pOrd));
  const secondaryOrd = B_ord != null ? B_ord : expOrd;
  const ordProj = w * A_ord + (1 - w) * secondaryOrd;
  const revProj = w * A_rev + (1 - w) * secondaryOrd * P.aov;
  const projCk = ckToday != null ? ckToday / Math.max(pOrd, 0.03) : ordProj / 0.28;

  // Proyección del mes
  const dim = new Date(et.y, et.m, 0).getDate();
  let futureRev = 0, futureOrd = 0;
  for (let d = et.d + 1; d <= dim; d++) { const dw = dowMon(et.y, et.m, d); futureRev += P.overall_daily_rev * P.wk_factor[dw] * P.dom_factor[d - 1]; futureOrd += P.overall_daily_ord * P.wk_factor[dw] * P.dom_factor[d - 1]; }
  const monthProjRev = (mtdRev - revToday) + revProj + futureRev;
  const monthProjOrd = (mtdOrd - ordToday) + ordProj + futureOrd;

  return {
    ts: new Date().toISOString(), tz: TZ, et, pOrd,
    day: {
      revToday, ordToday, revProj, ordProj, expRev, expOrd,
      goal: P.daily_goal, goalOk: revProj >= P.daily_goal, goalPct: Math.round(revProj / P.daily_goal * 100),
      aov: ordToday > 0 ? revToday / ordToday : null,
      rangeLow: Math.min(A_ord, secondaryOrd) * 0.9, rangeHigh: Math.max(A_ord, secondaryOrd) * 1.12,
      checkoutsToday: ckToday, abandonment: (ckToday && ckToday > 0) ? 1 - ordToday / ckToday : null
    },
    traffic: ga ? { sessionsSoFar: ga.sessions, projSessions: projSess, projUsers: projSess ? projSess * P.users_factor : null, projCart, expConv: P.conversion_by_dow[et.dow] } : null,
    funnelDay: { sess: projSess != null ? Math.round(projSess) : null, cart: projCart != null ? Math.round(projCart) : null, ck: Math.round(projCk), ord: Math.round(ordProj), bench: P.bench },
    month: { mtdRev, mtdOrd, projRev: monthProjRev, projOrd: monthProjOrd, avg: P.monthly_avg_rev, days: et.d, daysInMonth: dim, runRate: dim > et.d ? Math.max((P.monthly_avg_rev - mtdRev) / (dim - et.d), 0) : 0 },
    params: { dom_factor: P.dom_factor, mix: { labels: ["Vapes", "Concentrados", "Gummies", "Prerolls", "Flowers", "Chocolates", "Seeds"], data: [61.2, 10.2, 10.2, 8.9, 5.8, 2.7, 1.0] } },
    sources: src
  };
}
function nextDay(et) { const dt = new Date(Date.UTC(et.y, et.m - 1, et.d)); dt.setUTCDate(dt.getUTCDate() + 1); return dt.toISOString().slice(0, 10); }

// ----------------- SLACK -----------------
function money(n) { return "$" + Math.round(n).toLocaleString("en-US"); }
async function postToSlack(snap) {
  const hook = process.env.SLACK_WEBHOOK_URL; if (!hook) { console.log("SLACK_WEBHOOK_URL no configurado"); return; }
  const d = snap.day, mo = snap.month, et = snap.et;
  const url = process.env.DASHBOARD_URL || "";
  const emoji = d.goalOk ? "✅" : "⚠️";
  const lines = [
    `*📊 Trap University — Proyección de ventas · ${et.dateStr} ${String(et.hour).padStart(2, "0")}:${String(et.min).padStart(2, "0")} PT*`,
    `💰 *Ventas hoy:* ${money(d.revToday)} · proyectado *${money(d.revProj)}* (${d.goalPct}% de meta ${emoji})`,
    `🧾 Órdenes: ${d.ordToday} → proy. ~${Math.round(d.ordProj)}${d.aov ? ` · AOV ${money(d.aov)}` : ""}`,
    snap.traffic ? `👥 Tráfico: ~${Math.round(snap.traffic.projSessions)} sesiones · conversión esp. ${(snap.traffic.expConv * 100).toFixed(1)}%` : null,
    d.abandonment != null ? `🛒 Checkout: ${Math.round(d.abandonment * 100)}% abandono hoy` : null,
    `📅 Mes: ${money(mo.mtdRev)} MTD → proy. *${money(mo.projRev)}* (${mo.projRev >= mo.avg ? "+" : ""}${Math.round(mo.projRev / mo.avg * 100 - 100)}% vs promedio)`,
    url ? `🔗 <${url}|Abrir dashboard en vivo>` : null
  ].filter(Boolean);
  const r = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: lines.join("\n") }) });
  console.log("Slack enviado:", r.status);
}

// ----------------- RUTAS -----------------
app.use(express.static(path.join(__dirname, "public")));
app.get("/api/data", async (_req, res) => {
  try { res.json(await computeSnapshot()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/tasks/slack", async (req, res) => {
  if (process.env.CRON_TOKEN && req.query.token !== process.env.CRON_TOKEN) return res.status(403).send("forbidden");
  try { await postToSlack(await computeSnapshot()); res.send("ok"); } catch (e) { res.status(500).send(e.message); }
});
app.get("/health", (_req, res) => res.send("ok"));

// CLI: `node server.js --slack-once` (para el cron de Render)
if (process.argv.includes("--slack-once")) {
  computeSnapshot().then(postToSlack).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
} else {
  app.listen(PORT, () => console.log(`Trap U dashboard en http://localhost:${PORT} (TZ ${TZ})`));
}
