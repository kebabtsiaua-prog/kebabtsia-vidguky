// Glovo reviews from the daily «Відгуки щодня» report, the «беру в роботу» alerts for Glovo and Bolt complaints
// and the daily report about them for the owner, Роман and Юра.
// Glovo emails only a link to its portal, so the owner forwards the .csv to the bot (owner 2026-10-30).
import { negativeReviews } from "./ai.ts";
import { activeLocations, db, esc, hasComment, itemUrl, type Location, tabUrl, tg } from "./common.ts";
import { ownerId } from "./survey.ts";

export const GLOVO_REPORTS = "https://portal.glovoapp.com/report-builder";

// RFC 4180: quoted fields may hold commas, quotes ("") and line breaks (Дрогобич's store name spans three lines).
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

// The header is in the portal's language; the columns are found by name, Ukrainian or English.
const COLS: Record<string, RegExp> = {
  date: /^(дата|date)$/i,
  store: /^(назва закладу|store name|store)$/i,
  storeId: /^(id закладу|store id)$/i,
  order: /^(id замовлення|order id)$/i,
  rating: /^(рейтинг|rating)$/i,
  text: /^(текст відгуку|review text|review)$/i,
};
export function isGlovoReport(text: string): boolean {
  const head = parseCsv(text.slice(0, 2000))[0] ?? [];
  return ["storeId", "order", "text"].every((k) => head.some((h) => COLS[k].test(h.trim())));
}

// A store missing from locations.glovo_ids: match the street in its name, «Kebabtsia / Кебабця (вулиця Валова) [LVI]».
function guessLocation(name: string, locs: Location[]): Location | undefined {
  const inner = (name.match(/\(([^)]*)\)/)?.[1] ?? name).toLowerCase().replace(/\s+/g, " ");
  const words = inner.replace(/\b(вулиця|вул\.|проспект|просп\.|проїзд|бульвар|ukraine|львів|львівська)\b/g, " ")
    .split(/[^a-zа-яіїєґ']+/i).filter((w) => w.length >= 4);
  const hits = locs.filter((l) => [l.name, ...l.aliases].some((n) => words.some((w) => n.toLowerCase().includes(w))));
  return hits.length === 1 ? hits[0] : undefined;
}

export type ImportResult = {
  days: string[]; rows: number; fresh: number; withText: number; negative: number; complaints: { id: number; loc: string }[];
  unknown: string[];
};

export async function importGlovo(text: string): Promise<ImportResult> {
  const [head, ...rows] = parseCsv(text);
  const col = (k: string) => head.findIndex((h) => COLS[k].test(h.trim()));
  const ix = Object.fromEntries(Object.keys(COLS).map((k) => [k, col(k)]));
  const locs = await activeLocations();
  const { data: mapped } = await db.from("locations").select("id,glovo_ids").not("glovo_ids", "is", null);
  const byStore = new Map<number, Location>();
  for (const m of mapped ?? []) for (const s of m.glovo_ids ?? []) {
    const l = locs.find((x) => x.id === m.id);
    if (l) byStore.set(s, l);
  }
  const res: ImportResult = { days: [], rows: rows.length, fresh: 0, withText: 0, negative: 0, complaints: [], unknown: [] };
  const texts: { order: string; day: string; body: string; loc?: Location }[] = [];
  for (const r of rows) {
    const order = (r[ix.order] ?? "").trim(), storeId = Number(r[ix.storeId]);
    if (!order || !storeId) continue;
    const storeName = (r[ix.store] ?? "").replace(/\s+/g, " ").trim();
    const day = (r[ix.date] ?? "").trim().slice(0, 10);
    if (!res.days.includes(day)) res.days.push(day);
    let loc = byStore.get(storeId);
    if (!loc) {
      loc = guessLocation(storeName, locs);
      if (loc) {
        // Remember it, so the next report finds the store by its ID.
        const { data: cur } = await db.from("locations").select("glovo_ids").eq("id", loc.id).single();
        await db.from("locations").update({ glovo_ids: [...(cur?.glovo_ids ?? []), storeId] }).eq("id", loc.id);
        byStore.set(storeId, loc);
      } else if (!res.unknown.includes(storeName)) res.unknown.push(storeName);
    }
    const body = (r[ix.text] ?? "").trim();
    const rating = ix.rating >= 0 && r[ix.rating]?.trim() ? Number(r[ix.rating]) : null;
    const { data: ins } = await db.from("glovo_reviews").upsert({
      order_id: order, store_id: storeId, store_name: storeName, location_id: loc?.id ?? null, rated_on: day,
      rating: Number.isFinite(rating) ? rating : null, text: body,
    }, { onConflict: "order_id", ignoreDuplicates: true }).select("order_id");
    if (!ins?.length) continue;
    res.fresh++;
    if (hasComment(body)) texts.push({ order, day, body, loc });
  }
  // Only negative reviews become complaints (owner 2026-10-30); the AI reads the texts, the stars are always 0.
  res.withText = texts.length;
  const verdicts = await negativeReviews(texts.map((x) => x.body));
  for (const [i, x] of texts.entries()) {
    if (!verdicts[i].negative) continue;
    res.negative++;
    if (!x.loc) continue;
    const { data: c } = await db.from("complaints").insert({
      location_id: x.loc.id, channel: "Glovo", happened_on: x.day, text: x.body, topics: verdicts[i].topics,
      source: "glovo", external_id: `glovo:${x.order}`,
    }).select("id").single();
    if (!c) continue;
    await db.from("glovo_reviews").update({ complaint_id: c.id }).eq("order_id", x.order);
    res.complaints.push({ id: c.id, loc: x.loc.name });
    await alertTake(c.id);
  }
  res.days.sort();
  return res;
}

// ---------- «беру в роботу» ----------
type Comp = { id: number; location_id: number; channel: string; text: string; rating: number | null; source: string; created_by: number | null; taken_by: number | null; taken_at: string | null; created_at: string };

const hm = (iso: string) => new Date(iso).toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" });

async function alertText(c: Comp, viewer: number, taker: string | null): Promise<string> {
  const { data: loc } = await db.from("locations").select("name").eq("id", c.location_id).single();
  let from = "";
  if (c.source === "glovo") from = "🤖 бот знайшов у звіті Glovo";
  else if (c.created_by) {
    const { data: a } = await db.from("users").select("name").eq("tg_id", c.created_by).maybeSingle();
    from = `додав(ла) ${esc(a?.name ?? "")}`;
  }
  const lines = [
    `🔴 <b>Нова скарга · ${esc(c.channel)}</b>`,
    "",
    `<b>Точка:</b> ${esc(loc?.name ?? "")}`,
    from ? `<b>Звідки:</b> ${from}` : "",
    `<blockquote>${esc(c.text)}</blockquote>`,
  ].filter((x, i) => x || i === 1);
  if (c.taken_at) {
    lines.push(c.taken_by === viewer ? `✅ <b>Ви взяли в роботу о ${hm(c.taken_at)}</b>`
      : `✅ <b>Взяв(ла) в роботу ${esc(taker ?? "")} о ${hm(c.taken_at)}</b>`);
  }
  return lines.join("\n");
}

function alertKb(c: Comp, canTake: boolean) {
  const rows = [];
  if (!c.taken_at && canTake) rows.push([{ text: "👀 Переглянув, беру в роботу", callback_data: `tk:${c.id}` }]);
  rows.push([{ text: "Відкрити скаргу", web_app: { url: itemUrl(c.id) } }]);
  return { inline_keyboard: rows };
}

async function loadComp(id: number): Promise<Comp | null> {
  const { data } = await db.from("complaints").select("id,location_id,channel,text,rating,source,created_by,taken_by,taken_at,created_at").eq("id", id).maybeSingle();
  return data as Comp | null;
}

// Each new Glovo or Bolt complaint goes only to the location's admins: they react first (owner 2026-10-30).
// The owner, Роман and Юра get one report a day instead (dailyReport). Whoever added it gets the button on their
// own «Збережено» message (skip).
export async function alertTake(id: number, skip?: number): Promise<number> {
  const c = await loadComp(id);
  if (!c) return 0;
  const { data: la } = await db.from("user_locations").select("tg_id").eq("location_id", c.location_id);
  const { data: active } = await db.from("users").select("tg_id").eq("active", true).eq("role", "loc_admin");
  const live = new Set((active ?? []).map((u) => u.tg_id));
  const admins = [...new Set((la ?? []).map((r) => r.tg_id))].filter((t) => live.has(t) && t !== skip);
  let sent = 0;
  for (const to of admins) {
    const r = await tg("sendMessage", { chat_id: to, parse_mode: "HTML", text: await alertText(c, to, null), reply_markup: alertKb(c, true) })
      .catch(console.error);
    if (!r?.ok) continue;
    sent++;
    await db.from("complaint_alerts").upsert({ complaint_id: c.id, chat_id: to, message_id: r.result.message_id });
  }
  return sent;
}

// The «беру в роботу» button: the first press wins, and every alert about the complaint shows who took it.
export async function take(id: number, by: { tg_id: number; name: string }): Promise<string> {
  const { data: upd } = await db.from("complaints").update({ taken_by: by.tg_id, taken_at: new Date().toISOString() })
    .eq("id", id).is("taken_at", null).select("id");
  const c = await loadComp(id);
  if (!c) return "Скаргу не знайдено";
  const { data: t } = c.taken_by ? await db.from("users").select("name").eq("tg_id", c.taken_by).maybeSingle() : { data: null };
  const { data: alerts } = await db.from("complaint_alerts").select("chat_id,message_id").eq("complaint_id", id);
  for (const a of alerts ?? []) {
    await tg("editMessageText", {
      chat_id: a.chat_id, message_id: a.message_id, parse_mode: "HTML",
      text: await alertText(c, a.chat_id, t?.name ?? null), reply_markup: alertKb(c, false),
    }).catch(console.error);
  }
  return upd?.length ? "Взято в роботу" : `Уже взяв(ла) ${t?.name ?? "інший адмін"}`;
}

export async function takeButtonFor(id: number) {
  const c = await loadComp(id);
  return c ? alertKb(c, true) : undefined;
}

// Evening reminder to the owner (owner 2026-10-30: «ти просто будеш писати мені, що скинь файл»).
// Sent once a day, and only while yesterday's report has not been forwarded yet.
export async function remindGlovo(today: string): Promise<Record<string, unknown>> {
  const y = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
  const { count } = await db.from("glovo_reviews").select("order_id", { count: "exact", head: true }).eq("rated_on", y);
  if (count) return { ok: true, sent: 0, reason: "already imported" };
  const key = `glovo-remind-${today}`;
  const { error: dup } = await db.from("bot_announcements").insert({ key, info: {} });
  if (dup) return { ok: true, sent: 0, reason: "already sent today" };
  const owner = await ownerId();
  if (!owner) return { ok: false, sent: 0, reason: "no owner" };
  const r = await tg("sendMessage", {
    chat_id: owner, parse_mode: "HTML",
    text: "📥 <b>Звіт Glovo «Відгуки щодня» готовий</b>\n\nВідкрийте звіти Glovo, натисніть «Завантажити» біля верхнього звіту і перешліть файл сюди. Я сам розберу відгуки по точках.",
    reply_markup: { inline_keyboard: [[{ text: "Відкрити звіти Glovo", url: GLOVO_REPORTS }]] },
  });
  return { ok: !!r?.ok, sent: r?.ok ? 1 : 0 };
}

// One report a day for the owner, Роман and Юра (owner 2026-10-30): Glovo and Bolt complaints added yesterday and
// whether the location's admin took each of them. Sent with the morning digest, once a day.
export async function dailyReport(today: string): Promise<number> {
  const y = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
  const kyivDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date(iso));
  const { data: near } = await db.from("complaints").select("id,location_id,channel,taken_by,taken_at,created_at")
    .in("channel", ["Glovo", "Bolt"]).gte("created_at", new Date(Date.parse(y) - 86400000).toISOString()).lt("created_at", `${today}T23:59:59Z`).order("location_id");
  const rows = (near ?? []).filter((r) => kyivDay(r.created_at) === y);
  if (!rows.length) return 0;
  const { error: dup } = await db.from("bot_announcements").insert({ key: `glovo-day-${today}`, info: { n: rows.length } });
  if (dup) return 0;
  const locs = await activeLocations();
  const takers = [...new Set(rows.map((r) => r.taken_by).filter(Boolean))];
  const { data: who } = takers.length ? await db.from("users").select("tg_id,name").in("tg_id", takers) : { data: [] };
  const name = (id: number) => (locs.find((l) => l.id === id)?.name ?? "").replace(/^Львів, /, "");
  const taken = rows.filter((r) => r.taken_at).length;
  const lines = [`📦 <b>Glovo і Bolt за ${y.slice(8, 10)}.${y.slice(5, 7)}</b>`, "", `Нових скарг: <b>${rows.length}</b>, адміни взяли в роботу: <b>${taken}</b>.`, ""];
  for (const r of rows.slice(0, 15)) {
    const mins = r.taken_at ? Math.max(0, Math.round((Date.parse(r.taken_at) - Date.parse(r.created_at)) / 60000)) : 0;
    const after = mins < 60 ? `${mins} хв` : mins < 1440 ? `${Math.round(mins / 60)} год` : `${Math.round(mins / 1440)} дн`;
    const by = (who ?? []).find((w) => w.tg_id === r.taken_by)?.name ?? "адмін";
    lines.push(`· ${esc(name(r.location_id))} · ${r.channel} · ${r.taken_at ? `✅ ${esc(by)}, через ${after}` : "⏳ ще не взяли"}`);
  }
  if (rows.length > 15) lines.push(`· і ще ${rows.length - 15}`);
  const owner = await ownerId();
  const { data: bosses } = await db.from("users").select("tg_id").eq("active", true).eq("can_grant", true);
  let sent = 0;
  for (const to of new Set([owner, ...(bosses ?? []).map((b) => b.tg_id)].filter((t): t is number => !!t))) {
    const r = await tg("sendMessage", {
      chat_id: to, parse_mode: "HTML", text: lines.join("\n"),
      reply_markup: { inline_keyboard: [[{ text: "Відкрити чергу", web_app: { url: tabUrl("queue") } }]] },
    }).catch(console.error);
    if (r?.ok) sent++;
  }
  return sent;
}
