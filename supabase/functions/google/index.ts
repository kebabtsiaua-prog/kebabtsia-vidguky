// Google ratings: once a day (called by the keep-awake workflow) takes each location's rating and review count
// from the Places API, keeps a daily snapshot and fills google_monthly. On the first run of a month it sends
// admins last month's summary. The same call returns the reviews Google shows for the place (up to 5): a new one with
// 1–3 stars becomes a complaint and a direct message to the team, like a low app rating.
// Needs GOOGLE_MAPS_API_KEY in Supabase secrets; without it does nothing.
import { db, itemUrl, kyivToday, tg } from "../_shared/common.ts";
import { NEGATIVE_MAX, recipients } from "../_shared/uployal.ts";

const PLACES = "https://places.googleapis.com/v1";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

type Loc = { id: number; name: string; google_place_id: string | null; google_query: string | null };
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

// The chain's place for a location, found by name. Only a result named «Кебабця…» and not taken by another location counts.
async function findPlace(key: string, l: Loc, taken: Set<string>) {
  const data = await places(key, "places:searchText", "places.id,places.displayName,places.formattedAddress", {
    textQuery: l.google_query || `Кебабця ${l.name}`, languageCode: "uk", regionCode: "UA",
  });
  const p = (data.places ?? []).find((x: { id: string; displayName?: { text?: string } }) =>
    /кебаб|kebab/i.test(x.displayName?.text ?? "") && !taken.has(x.id)
  );
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

type Review = {
  name: string; rating?: number; publishTime?: string;
  text?: { text?: string }; originalText?: { text?: string }; authorAttribution?: { displayName?: string };
};
const escH = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const DAY = 86400000;

// Records reviews not seen before. A low one published in the last 14 days becomes a complaint; on the first check of a
// place only ones from the last 2 days do, so older reviews already entered by hand are not added again.
async function takeReviews(l: Loc, reviews: Review[]) {
  if (!reviews.length) return 0;
  const { count: seen } = await db.from("google_reviews").select("id", { count: "exact", head: true }).eq("location_id", l.id);
  const window = (seen ? 14 : 2) * DAY;
  let made = 0;
  for (const r of reviews) {
    const text = (r.originalText?.text || r.text?.text || "").trim();
    const author = r.authorAttribution?.displayName ?? "";
    const { error } = await db.from("google_reviews").insert({
      id: r.name, location_id: l.id, rating: r.rating ?? null, text, author, published_at: r.publishTime ?? null,
    });
    if (error) continue; // seen before
    const at = r.publishTime ? new Date(r.publishTime) : null;
    if (!r.rating || r.rating > NEGATIVE_MAX || !at || Date.now() - at.getTime() > window) continue;
    const day = at.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
    const { data: c } = await db.from("complaints").insert({
      location_id: l.id, channel: "Google", happened_on: day, rating: r.rating,
      text: text || `Оцінка ${r.rating} без коментаря`, source: "google", external_id: `google:${r.name}`,
    }).select("id").maybeSingle();
    if (!c) continue;
    made++;
    const msg = [
      `🔴 <b>Відгук ${r.rating} з 5 у Google</b>`,
      `${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)} · ${day.split("-").reverse().join(".")}`,
      "",
      `<b>Точка:</b> ${escH(l.name)}`,
    ];
    if (author) msg.push(`<b>Гість:</b> ${escH(author)}`);
    msg.push(text ? `<blockquote>${escH(text)}</blockquote>` : "<i>Без тексту, лише оцінка.</i>", "<i>Дайте відповідь на відгук у Google і запишіть рішення в апці.</i>");
    for (const u of await recipients()) {
      await tg("sendMessage", {
        chat_id: u.tg_id, parse_mode: "HTML", text: msg.join("\n"),
        reply_markup: { inline_keyboard: [[{ text: "Відкрити скаргу", web_app: { url: itemUrl(c.id) } }]] },
      }).catch(console.error);
    }
  }
  return made;
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
  const params = new URL(req.url).searchParams;
  if (params.has("list")) return json(await listMatches());
  const key = Deno.env.get("GOOGLE_MAPS_API_KEY")?.trim();
  if (!key) return json({ ok: false, reason: "GOOGLE_MAPS_API_KEY is not set" });
  const today = kyivToday();
  const month = monthStart(today);
  const { data } = await db.from("locations").select("id,name,google_place_id,google_query").eq("active", true).order("id");
  const locs = (data ?? []) as Loc[];
  const { data: done } = await db.from("google_daily").select("location_id").eq("day", today);
  // ?reviews=1 checks every place again today, for a first look at the reviews (each call is billed).
  const doneIds = new Set(params.has("reviews") ? [] : (done ?? []).map((d) => d.location_id));
  const errors: string[] = [];
  let taken = 0, complaints = 0;
  for (const l of locs.filter((l) => !doneIds.has(l.id))) {
    try {
      const used = new Set(locs.filter((o) => o.id !== l.id && o.google_place_id).map((o) => o.google_place_id!));
      const id = l.google_place_id || await findPlace(key, l, used);
      if (id) l.google_place_id = id;
      if (!id) {
        errors.push(`${l.name}: не знайдено в Google`);
        continue;
      }
      const p = await places(key, `places/${id}?languageCode=uk`, "rating,userRatingCount,reviews");
      const { error } = await db.from("google_daily").upsert({
        location_id: l.id, day: today, rating: p.rating ?? null, count: p.userRatingCount ?? 0,
      });
      if (error) throw new Error(error.message);
      taken++;
      complaints += await takeReviews(l, p.reviews ?? []);
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
  return json({ ok: !errors.length, day: today, taken, already: doneIds.size, complaints, reported, errors });
});
