// Poster POS: number of checks (receipts) per location per month, for the complaints-to-checks ratio.
// Needs POSTER_TOKEN in Supabase secrets (Poster → Доступ → Інтеграції → «Особиста інтеграція»).
// ?probe=1 shows only the shape of Poster's answers (keys and types, spot names), never figures, because the
// deploy log of this public repo shows it.
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

Deno.serve(async (req) => {
  const token = Deno.env.get("POSTER_TOKEN")?.trim();
  if (!token) return json({ ok: false, reason: "POSTER_TOKEN is not set" });
  if (!new URL(req.url).searchParams.has("probe")) return json({ ok: false, reason: "not ready yet" });
  const now = new Date(), from = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), to = ymd(now);
  const out: Record<string, unknown> = {};
  let spot = "";
  try {
    // deno-lint-ignore no-explicit-any
    const spots: any[] = await poster(token, "access.getSpots");
    out.spots = spots.map((s) => `${s.spot_id}: ${s.spot_name ?? s.name} | ${s.spot_adress ?? s.address ?? ""}`);
    out.spotShape = shape(spots[0]);
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
