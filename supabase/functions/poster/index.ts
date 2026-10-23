// Poster POS: number of checks (receipts) per location per month, for the complaints-to-checks ratio.
// Needs POSTER_TOKEN in Supabase secrets (Poster → Доступ → Інтеграції → «Особиста інтеграція»).
// Run daily by the keep-awake workflow: fills checks_monthly for this month and last month from each location's spots
// (locations.poster_spots). The answer names spots that had checks but belong to no location, never the figures.
// ?probe=1 shows only the shape of Poster's answers (keys and types, spot names), never figures, because the
// deploy log of this public repo shows it.
import { db, kyivToday } from "../_shared/common.ts";

const API = "https://joinposter.com/api";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

async function poster(token: string, method: string, params: Record<string, string> = {}) {
  const q = new URLSearchParams({ token, ...params });
  const res = await fetch(`${API}/${method}?${q}`);
  const data = await res.json().catch(() => ({}));
  if (data?.error) throw new Error(`${method}: ${data.error?.message ?? JSON.stringify(data.error)}`);
  return data?.response;
}

// deno-lint-ignore no-explicit-any
function shape(v: any, depth = 0): unknown {
  if (Array.isArray(v)) return v.length ? [`${v.length}×`, shape(v[0], depth + 1)] : [];
  if (v && typeof v === "object") {
    if (depth > 3) return "{…}";
    return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, shape(x, depth + 1)]));
  }
  return typeof v;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "");

const compact = (iso: string) => iso.replaceAll("-", "");
function monthsBack(today: string) {
  const d = new Date(today.slice(0, 8) + "01T00:00:00Z"), cur = d.toISOString().slice(0, 10);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return [d.toISOString().slice(0, 10), cur];
}
function lastDay(month: string, today: string) {
  const d = new Date(month + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  const end = d.toISOString().slice(0, 10);
  return end < today ? end : today;
}

// Checks (closed receipts) of one spot over a period.
async function spotChecks(token: string, spot: number, from: string, to: string) {
  const r = await poster(token, "dash.getAnalytics", {
    dateFrom: compact(from), dateTo: compact(to), type: "spots", id: String(spot), select: "transactions",
  });
  return Number(r?.counters?.transactions ?? 0) || 0;
}

async function fill(token: string) {
  const today = kyivToday();
  const { data: locs } = await db.from("locations").select("id,name,poster_spots").eq("active", true);
  // deno-lint-ignore no-explicit-any
  const spots: any[] = await poster(token, "access.getSpots");
  const mapped = new Set((locs ?? []).flatMap((l) => l.poster_spots ?? []));
  const errors: string[] = [], rows = [], idle: string[] = [], stray: string[] = [];
  for (const month of monthsBack(today)) {
    const to = lastDay(month, today);
    for (const l of locs ?? []) {
      if (!l.poster_spots?.length) continue;
      let sum = 0;
      for (const s of l.poster_spots) {
        try {
          const n = await spotChecks(token, s, month, to);
          sum += n;
          if (!n && month < today.slice(0, 8) + "01") idle.push(`${l.name}: заклад ${s}`);
        } catch (e) {
          errors.push(`${l.name}: ${(e as Error).message}`);
        }
      }
      rows.push({ location_id: l.id, month, checks: sum });
    }
  }
  // Spots that sold something this month but are not tied to a location.
  for (const s of spots.filter((s) => !mapped.has(Number(s.spot_id)))) {
    try {
      if (await spotChecks(token, Number(s.spot_id), monthsBack(today)[1], today)) stray.push(`${s.spot_id} ${s.spot_name}`);
    } catch (_) { /* closed spot */ }
  }
  const { error } = await db.from("checks_monthly").upsert(rows, { onConflict: "location_id,month" });
  if (error) errors.push(`checks_monthly: ${error.message}`);
  const empty = rows.filter((r) => !r.checks).map((r) => `${(locs ?? []).find((l) => l.id === r.location_id)?.name} ${r.month.slice(0, 7)}`);
  return { ok: !errors.length, saved: rows.length, empty, idle, stray, errors };
}

Deno.serve(async (req) => {
  const token = Deno.env.get("POSTER_TOKEN")?.trim();
  if (!token) return json({ ok: false, reason: "POSTER_TOKEN is not set" });
  if (!new URL(req.url).searchParams.has("probe")) return json(await fill(token));
  const now = new Date(), from = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), to = ymd(now);
  const out: Record<string, unknown> = {};
  let spot = "";
  try {
    // deno-lint-ignore no-explicit-any
    const spots: any[] = await poster(token, "access.getSpots");
    out.spots = spots.length;
    spot = String(spots[0]?.spot_id ?? "");
  } catch (e) {
    out.spots = (e as Error).message;
  }
  const tries: [string, Record<string, string>][] = [
    ["dash.getSpotsSales", { dateFrom: from, dateTo: to, spot_id: spot }],
    ["dash.getAnalytics", { dateFrom: from, dateTo: to, type: "spots", id: spot, select: "transactions" }],
    ["dash.getTransactions", { dateFrom: to, dateTo: to, per_page: "2", page: "1" }],
    ["transactions.getTransactions", { date_from: to, date_to: to, per_page: "2", page: "1" }],
  ];
  for (const [m, p] of tries) {
    try {
      out[m] = shape(await poster(token, m, p));
    } catch (e) {
      out[m] = (e as Error).message;
    }
  }
  return json(out);
});
