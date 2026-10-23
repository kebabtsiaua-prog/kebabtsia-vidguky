// App order ratings that Uployal's bot posts into the per-location Telegram groups.
// Our bot sits in those groups as an admin (Bot-to-Bot Communication Mode on, Group Privacy off), never writes there,
// keeps every rating for the monthly count and turns low ones into complaints with a direct message to the team.
import { APP_URL, db, kyivToday, tg } from "./common.ts";

export const NEGATIVE_MAX = 3; // 1–3 stars count as a complaint

type Loc = { id: number; name: string; city: string; aliases: string[]; google_address: string | null };
export type Rating = { rating: number; comment: string; order: string | null; date: string | null; place: string; guest: string; phone: string };

const field = (text: string, label: string) =>
  text.match(new RegExp(`${label}[^:\\n]*:[ \\t]*([^\\n]*)`, "i"))?.[1]?.trim() ?? "";

// null when the message is not a rating.
export function parseRating(text: string): Rating | null {
  const stars = field(text, "Оцінка").match(/[1-5]/);
  if (!stars) return null;
  // The comment may run over several lines: everything after «Коментар:» up to the next «Label:» line.
  const c = text.match(/Коментар[^:\n]*:[ \t]*([\s\S]*?)(?=\n[^\n:]{2,40}:|$)/i)?.[1]?.trim() ?? "";
  const d = field(text, "Дата").match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  const year = d ? (d[3].length === 2 ? "20" + d[3] : d[3]) : "";
  return {
    rating: Number(stars[0]),
    comment: /^[-–—.]*$/.test(c) ? "" : c,
    order: field(text, "Номер замовлення").match(/[\w-]+/)?.[0] ?? null,
    date: d ? `${year}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}` : null,
    place: field(text, "Заклад"),
    guest: field(text, "Споживач"),
    phone: field(text, "Телефон"),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[ʼ'’`]/g, "").replace(/[^a-zа-яіїєґ0-9]+/g, " ").trim();
const STREET_WORDS = /^(вулиця|вул|проспект|просп|пр|бульвар|бульв|проїзд|урочище|участок|площа|пл|м|місто|львів)$/;

function keys(l: Loc) {
  const street = norm((l.google_address ?? l.name.split(",")[1] ?? "").split(",")[0]).split(" ")
    .filter((w) => w.length > 3 && !STREET_WORDS.test(w) && !/\d/.test(w));
  const num = (l.google_address ?? "").split(",")[1]?.trim().toLowerCase().replace(/\s+/g, "") ?? "";
  const nicks = [...l.aliases, ...(l.name.match(/\(([^)]+)\)/)?.[1] ?? "").split(/\s+/)].map(norm).filter((w) => w.length > 3 && w !== "трц");
  return { street, num, nicks, city: norm(l.city) };
}

// Best location for an address or a chat title; null when unsure.
export function matchLocation(text: string, locs: Loc[]): number | null {
  const t = ` ${norm(text)} `;
  const compact = t.replace(/\s+/g, "");
  const scored = locs.map((l) => {
    const k = keys(l);
    let s = 0;
    if (k.street.some((w) => t.includes(` ${w}`))) s += 2;
    if (k.num && new RegExp(`(^|[^0-9])${k.num.replace(/[^a-zа-яіїєґ0-9]/g, "")}([^0-9]|$)`).test(compact)) s += 2;
    if (k.nicks.some((w) => t.includes(` ${w}`))) s += 4;
    if (t.includes(` ${k.city}`)) s += 1;
    return { id: l.id, s, onlyInCity: locs.filter((o) => o.city === l.city).length === 1 };
  }).filter((x) => x.s >= 3 || (x.onlyInCity && x.s >= 1)).sort((a, b) => b.s - a.s);
  if (!scored.length || (scored[1] && scored[1].s === scored[0].s)) return null;
  return scored[0].id;
}

const fmt = (iso: string) => iso.split("-").reverse().join(".");
function escH(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

// deno-lint-ignore no-explicit-any
export async function onGroupMessage(msg: any) {
  const chat = msg.chat;
  const text: string = (msg.text ?? msg.caption ?? "").trim();
  const { data: known } = await db.from("tg_chats").select("*").eq("chat_id", chat.id).maybeSingle();
  const { data: locData } = await db.from("locations").select("id,name,city,aliases,google_address").eq("active", true);
  const locs = (locData ?? []) as Loc[];
  const r = text ? parseRating(text) : null;
  let locId: number | null = known?.location_id ?? matchLocation(chat.title ?? "", locs);
  if (r) locId = matchLocation(r.place, locs) ?? locId;
  await db.from("tg_chats").upsert({
    chat_id: chat.id, title: chat.title ?? "", type: chat.type,
    location_id: known?.location_id ?? (r && locId ? locId : known?.location_id ?? null),
    messages: (known?.messages ?? 0) + 1, ratings: (known?.ratings ?? 0) + (r ? 1 : 0),
    last_message_at: new Date().toISOString(),
  });
  if (!r) return;
  if (!locId) {
    console.error("rating without location", chat.title, r.place);
    return;
  }
  const day = r.date ?? kyivToday();
  const ext = r.order ? `uployal:${r.order}` : `tg:${chat.id}:${msg.message_id}`;
  const { error } = await db.from("app_ratings").insert({
    location_id: locId, rated_on: day, rating: r.rating, comment: r.comment, external_id: ext, chat_id: chat.id,
  });
  if (error) return; // already counted (same order posted twice)
  if (r.rating > NEGATIVE_MAX) return;

  const { data: c } = await db.from("complaints").insert({
    location_id: locId, channel: "Оцінки в додатку", happened_on: day, rating: r.rating,
    text: r.comment || `Оцінка ${r.rating} без коментаря`, source: "uployal", external_id: ext,
  }).select("id").maybeSingle();
  if (!c) return;
  const loc = locs.find((l) => l.id === locId)!;
  const lines = [
    `⚠️ <b>Негативна оцінка в додатку</b>`,
    `📍 ${escH(loc.name)}`,
    `${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)} ${r.rating} з 5 · ${fmt(day)}`,
    `💬 ${r.comment ? escH(r.comment) : "<i>без коментаря</i>"}`,
  ];
  if (r.guest || r.phone) lines.push(`👤 ${escH([r.guest, r.phone].filter(Boolean).join(", "))}`);
  if (r.order) lines.push(`🧾 Замовлення ${escH(r.order)}`);
  lines.push("", "Зверніть увагу і зв'яжіться з гостем. Рішення запишіть в апці.");
  const { data: team } = await db.from("users").select("tg_id").in("role", ["admin", "comms"]).eq("active", true);
  for (const u of team ?? []) {
    await tg("sendMessage", {
      chat_id: u.tg_id, parse_mode: "HTML", text: lines.join("\n"),
      reply_markup: { inline_keyboard: [[{ text: "📊 Відкрити апку", web_app: { url: APP_URL } }]] },
    }).catch(console.error);
  }
}

// The bot was added to or removed from a group, or its rights changed.
// deno-lint-ignore no-explicit-any
export async function onMembership(m: any) {
  const status = m.new_chat_member?.status;
  await db.from("tg_chats").upsert({
    chat_id: m.chat.id, title: m.chat.title ?? "", type: m.chat.type,
    is_admin: status === "administrator", left: status === "left" || status === "kicked",
  });
}

// GET bot?chats=1: the groups the bot is in, to check the setup after a deploy.
export async function listChats() {
  const { data } = await db.from("tg_chats").select("*").order("title");
  const { data: locs } = await db.from("locations").select("id,name");
  return (data ?? []).map((c) =>
    `${c.title || c.chat_id} · ${c.left ? "вийшов" : c.is_admin ? "адмін" : "НЕ адмін"} · повідомлень ${c.messages}, оцінок ${c.ratings} · ${
      locs?.find((l) => l.id === c.location_id)?.name ?? "точка не визначена"
    }`
  );
}
