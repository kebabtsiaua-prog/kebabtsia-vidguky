// Google ratings: once a day (called by the keep-awake workflow) takes each location's rating and review count
// from the Places API, keeps a daily snapshot and fills google_monthly. On the first run of a month it sends
// admins last month's summary. Needs GOOGLE_MAPS_API_KEY in Supabase secrets; without it does nothing.
import { db, kyivToday, tg } from "../_shared/common.ts";

const PLACES = "https://places.googleapis.com/v1";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

type Loc = { id: number; name: string; google_place_id: string | null };
type Snap = { location_id: number; day: string; rating: number | null; count: number | null };

async function places(key: string, path: string, mask: string, body?: unknown) {
  const res = await fetch(`${PLACES}/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": mask },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google ${res.status}: ${data?.error?.message ?? ""}`);
  return data;
}

// The chain's place for a location, found by name. Only a result named «Кебабця…» counts.
async function findPlace(key: string, l: Loc) {
  const data = await places(key, "places:searchText", "places.id,places.displayName,places.formattedAddress", {
    textQuery: `Кебабця ${l.name}`, languageCode: "uk", regionCode: "UA",
  });
  const p = (data.places ?? []).find((x: { displayName?: { text?: string } }) => /кебаб|kebab/i.test(x.displayName?.text ?? ""));
  if (!p) return null;
  await db.from("locations").update({ google_place_id: p.id, google_address: p.formattedAddress ?? null }).eq("id", l.id);
  return p.id as string;
}

function monthStart(day: string) {
  return day.slice(0, 8) + "01";
}
function prevMonth(month: string) {
  const d = new Date(month + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

// google_monthly for one month from the snapshots: start = last snapshot before the month (or the first in it),
// end = latest, new reviews = latest count − start count. A start already recorded (e.g. from the sheet) is kept.
async function fillMonth(month: string, locs: Loc[]) {
  const { data: snaps } = await db.from("google_daily").select("*").gte("day", prevMonth(month)).order("day");
  const { data: rows } = await db.from("google_monthly").select("*").eq("month", month);
  const out = [];
  for (const l of locs) {
    const mine = ((snaps ?? []) as Snap[]).filter((s) => s.location_id === l.id && s.count != null);
    const inMonth = mine.filter((s) => s.day >= month && s.day < nextMonth(month));
    if (!inMonth.length) continue;
    const base = mine.filter((s) => s.day < month).at(-1) ?? inMonth[0];
    const last = inMonth.at(-1)!;
    const old = (rows ?? []).find((r) => r.location_id === l.id);
    out.push({
      location_id: l.id, month,
      start_rating: old?.start_rating ?? base.rating,
      end_rating: last.rating,
      total: last.count,
      new_reviews: last.count! - base.count!,
    });
  }
  if (out.length) {
    const { error } = await db.from("google_monthly").upsert(out, { onConflict: "location_id,month" });
    if (error) throw new Error(`google_monthly: ${error.message}`);
  }
}
function nextMonth(month: string) {
  const d = new Date(month + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
const f1 = (n: number | null) => (n == null ? "—" : Number(n).toFixed(1).replace(".", ","));

// Last month's summary to every admin, once.
async function monthlyReport(month: string, locs: Loc[]) {
  const { data: rows } = await db.from("google_monthly").select("*").eq("month", month).not("end_rating", "is", null);
  if (!rows?.length) return false;
  const { error } = await db.from("google_reports").insert({ month });
  if (error) return false; // already sent
  const name = (id: number) => locs.find((l) => l.id === id)?.name ?? `#${id}`;
  rows.sort((a, b) => b.end_rating - a.end_rating);
  const lines = rows.map((r, i) => {
    const d = r.start_rating == null ? 0 : Math.round((r.end_rating - r.start_rating) * 10) / 10;
    const arrow = d > 0 ? ` ▲${f1(d)}` : d < 0 ? ` ▼${f1(-d)}` : "";
    const nw = r.new_reviews ? `, +${r.new_reviews} відг.` : "";
    return `${i + 1}. ${name(r.location_id)}: <b>${f1(r.end_rating)}</b> (було ${f1(r.start_rating)}${arrow}${nw})`;
  });
  const down = rows.filter((r) => r.start_rating != null && r.end_rating < r.start_rating).length;
  const m = new Date(month + "T00:00:00Z");
  const text = `⭐ <b>Google за ${MONTHS[m.getUTCMonth()]} ${m.getUTCFullYear()}</b>\n` +
    (down ? `Оцінка впала: ${down} з ${rows.length} точок.\n` : "") + "\n" + lines.join("\n");
  const { data: admins } = await db.from("users").select("tg_id").eq("role", "admin").eq("active", true);
  for (const a of admins ?? []) await tg("sendMessage", { chat_id: a.tg_id, text, parse_mode: "HTML" }).catch(console.error);
  return true;
}

// ?list=1: which Google place each location is matched to, to check the matches. Reads only the database.
async function listMatches() {
  const { data: locs } = await db.from("locations").select("id,name,google_place_id,google_address").eq("active", true).order("name");
  const { data: snaps } = await db.from("google_daily").select("*").eq("day", kyivToday());
  const ids = (locs ?? []).map((l) => l.google_place_id).filter(Boolean);
  return (locs ?? []).map((l) => {
    const s = (snaps ?? []).find((x) => x.location_id === l.id);
    const dup = l.google_place_id && ids.filter((i) => i === l.google_place_id).length > 1 ? " ⚠ ДУБЛЬ" : "";
    return `${l.name} → ${l.google_address ?? "не знайдено"} · ${s?.rating ?? "—"} (${s?.count ?? "—"})${dup}`;
  });
}

Deno.serve(async (req) => {
  if (new URL(req.url).searchParams.has("list")) return json(await listMatches());
  const key = Deno.env.get("GOOGLE_MAPS_API_KEY")?.trim();
  if (!key) return json({ ok: false, reason: "GOOGLE_MAPS_API_KEY is not set" });
  const today = kyivToday();
  const month = monthStart(today);
  const { data } = await db.from("locations").select("id,name,google_place_id").eq("active", true).order("id");
  const locs = (data ?? []) as Loc[];
  const { data: done } = await db.from("google_daily").select("location_id").eq("day", today);
  const doneIds = new Set((done ?? []).map((d) => d.location_id));
  const errors: string[] = [];
  let taken = 0;
  for (const l of locs.filter((l) => !doneIds.has(l.id))) {
    try {
      const id = l.google_place_id || await findPlace(key, l);
      if (!id) {
        errors.push(`${l.name}: не знайдено в Google`);
        continue;
      }
      const p = await places(key, `places/${id}`, "rating,userRatingCount");
      const { error } = await db.from("google_daily").upsert({
        location_id: l.id, day: today, rating: p.rating ?? null, count: p.userRatingCount ?? 0,
      });
      if (error) throw new Error(error.message);
      taken++;
    } catch (e) {
      errors.push(`${l.name}: ${(e as Error).message}`);
    }
  }
  let reported = false;
  try {
    if (taken) await fillMonth(month, locs);
    reported = await monthlyReport(prevMonth(month), locs);
  } catch (e) {
    errors.push((e as Error).message);
  }
  return json({ ok: !errors.length, day: today, taken, already: doneIds.size, reported, errors });
});
