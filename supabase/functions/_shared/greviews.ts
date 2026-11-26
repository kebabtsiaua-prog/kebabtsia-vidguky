// Every new Google review goes to the communication team in the bot (owner 2026-11-25: Лена й Аня бачать усі відгуки,
// і добрі, і погані, відповідають прямо з бота, бот нагадує, якщо відповіді нема). The card is edited in every chat
// once someone replies, so nobody answers twice.
import Anthropic from "npm:@anthropic-ai/sdk@0.133.0";
import { db, itemUrl, tg, type User } from "./common.ts";
import { recipients } from "./uployal.ts";
import { escH } from "./googlerev.ts";

export type GRow = {
  id: string; key: number; location_id: number; rating: number | null; text: string | null; author: string | null;
  published_at: string | null; gbp_name: string | null; reply: string | null; reply_at: string | null;
  replied_by: string | null; complaint_id: number | null; tg_msgs: { chat_id: number; message_id: number }[];
};
type Loc = { id: number; name: string; google_place_id: string | null };

// ---- Google access (the refresh token the owner gave once through /google) ----
function client() {
  const id = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")?.trim(), secret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")?.trim();
  return id && secret ? { id, secret } : null;
}
export function oauthClient() {
  return client();
}
export async function tokenCall(body: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google вхід: ${data.error_description ?? data.error ?? res.status}`);
  return data as { access_token: string; refresh_token?: string };
}
// A fresh access token; null when Google is not connected.
export async function accessToken(): Promise<string | null> {
  const c = client();
  const { data: auth } = await db.from("google_auth").select("refresh_token").maybeSingle();
  if (!c || !auth) return null;
  return (await tokenCall({ client_id: c.id, client_secret: c.secret, refresh_token: auth.refresh_token, grant_type: "refresh_token" })).access_token;
}
export async function google(url: string, token: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google ${res.status}: ${data?.error?.message ?? res.statusText}`);
  return data;
}

// ---- The card ----
const fmt = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "");
const ROW = "id,key,location_id,rating,text,author,published_at,gbp_name,reply,reply_at,replied_by,complaint_id,tg_msgs";

async function loc(id: number): Promise<Loc> {
  const { data } = await db.from("locations").select("id,name,google_place_id").eq("id", id).single();
  return data as Loc;
}

export function cardText(r: GRow, l: Loc): string {
  const n = r.rating ?? 0;
  const lines = [
    `${n && n <= 3 ? "🔴" : "🟢"} <b>Новий відгук у Google</b>`,
    "",
    `<b>Точка:</b> ${escH(l.name)}`,
    `<b>Оцінка:</b> ${n ? "★".repeat(n) + "☆".repeat(5 - n) : "—"}${r.published_at ? ` · ${fmt(r.published_at)}` : ""}`,
  ];
  if (r.author) lines.push(`<b>Гість:</b> ${escH(r.author)}`);
  lines.push(r.text ? `<blockquote>${escH(r.text)}</blockquote>` : "<i>Без тексту, лише оцінка.</i>");
  if (r.complaint_id) lines.push(`⚠️ Скарга №${r.complaint_id} уже в апці.`);
  if (r.reply) {
    lines.push("", `💬 <b>Відповідь у Google</b>${r.replied_by ? ` · ${escH(r.replied_by)}` : ""}${r.reply_at ? `, ${fmt(r.reply_at)}` : ""}`, `<blockquote>${escH(r.reply)}</blockquote>`);
    lines.push(r.replied_by ? `✅ Відповіла ${escH(r.replied_by)}` : "✅ Відповіли в Google");
  }
  return lines.join("\n");
}

export function cardKb(r: GRow, l: Loc) {
  const rows: unknown[][] = [];
  rows.push(r.reply
    ? [{ text: "✏️ Змінити відповідь", callback_data: `gr:${r.key}:w` }]
    : [{ text: "✍️ Відповісти", callback_data: `gr:${r.key}:w` }, { text: "✨ Варіант відповіді", callback_data: `gr:${r.key}:ai` }]);
  const second: unknown[] = [];
  if (r.complaint_id) second.push({ text: "Відкрити скаргу", web_app: { url: itemUrl(r.complaint_id) } });
  if (l.google_place_id) second.push({ text: "Відкрити в Google", url: `https://www.google.com/maps/place/?q=place_id:${l.google_place_id}` });
  if (second.length) rows.push(second);
  return { inline_keyboard: rows };
}

export async function loadReview(key: number): Promise<GRow | null> {
  const { data } = await db.from("google_reviews").select(ROW).eq("key", key).maybeSingle();
  return (data as GRow) ?? null;
}

// A new review: a card to everyone on the team.
export async function notifyReview(id: string) {
  const { data } = await db.from("google_reviews").select(ROW).eq("id", id).maybeSingle();
  const r = data as GRow | null;
  if (!r) return 0;
  const l = await loc(r.location_id);
  const msgs: { chat_id: number; message_id: number }[] = [];
  for (const u of await recipients()) {
    const res = await tg("sendMessage", { chat_id: u.tg_id, parse_mode: "HTML", text: cardText(r, l), reply_markup: cardKb(r, l) }).catch(console.error);
    if (res?.ok) msgs.push({ chat_id: u.tg_id, message_id: res.result.message_id });
  }
  await db.from("google_reviews").update({ tg_msgs: msgs, notified_at: new Date().toISOString() }).eq("id", id);
  return msgs.length;
}

// The review changed (reply sent from the bot or written in Google): every card shows it.
export async function refreshCards(r: GRow) {
  const l = await loc(r.location_id);
  for (const m of r.tg_msgs ?? []) {
    await tg("editMessageText", { ...m, parse_mode: "HTML", text: cardText(r, l), reply_markup: cardKb(r, l) }).catch(console.error);
  }
}

// Who may answer reviews from the bot: the people who get the cards, the owner's admins and the communication role.
export async function mayReply(u: User): Promise<boolean> {
  if (u.role === "admin" || u.role === "comms") return true;
  return (await recipients()).some((x) => x.tg_id === u.tg_id);
}

// Posts (or replaces) the reply in Google.
export async function sendReply(r: GRow, text: string, u: User) {
  const token = await accessToken();
  if (!token) throw new Error("Google не підключено");
  if (!r.gbp_name) throw new Error("цей відгук прийшов не з профілю Google, відповісти з бота не можна");
  const res = await google(`https://mybusiness.googleapis.com/v4/${r.gbp_name}/reply`, token, { method: "PUT", body: JSON.stringify({ comment: text }) });
  const row = { reply: res.comment ?? text, reply_at: res.updateTime ?? new Date().toISOString(), replied_by: u.name, result: r.complaint_id ? undefined : "Відповіли на відгук" };
  await db.from("google_reviews").update(row).eq("id", r.id);
  const fresh = await loadReview(r.key);
  if (fresh) await refreshCards(fresh);
  if (r.complaint_id) {
    await db.from("complaints").update({ result: "Відповіли на відгук, гість не сконтактував" }).eq("id", r.complaint_id).is("result", null);
  }
}

// A draft reply written by AI, in the guest's language; null without the AI key.
export async function aiDraft(r: GRow): Promise<string | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  if (!apiKey) return null;
  const l = await loc(r.location_id);
  try {
    const client = new Anthropic({ apiKey });
    // deno-lint-ignore no-explicit-any
    const params: any = {
      model: "claude-opus-5-5",
      max_tokens: 1500,
      system: "Ти пишеш відповіді на відгуки в Google від імені мережі кебабних «Кебабця». Мова відповіді: мова відгуку (за замовчуванням українська). " +
        "Тон теплий і людяний, без канцеляриту, 1–3 речення. Звертайся до гостя на імʼя, якщо воно є. На добрий відгук подякуй і запроси знову. " +
        "На поганий: щиро перепроси за конкретну проблему, скажи, що передали команді точки, і попроси написати нам у Direct, щоб усе виправити. " +
        "Не обіцяй компенсацій і знижок, не сперечайся, не вигадуй фактів. Поверни лише текст відповіді.",
      messages: [{ role: "user", content: `Точка: ${l.name}\nГість: ${r.author || "без імені"}\nОцінка: ${r.rating ?? "?"} з 5\nВідгук: ${r.text || "(без тексту, лише оцінка)"}` }],
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
    const res = await client.beta.messages.create(params);
    const block = res.content.find((b: { type: string }) => b.type === "text") as { text?: string } | undefined;
    return res.stop_reason === "refusal" ? null : block?.text?.trim() || null;
  } catch (e) {
    console.error("google draft", e);
    return null;
  }
}

// 10:00, 14:00, 18:00 (with the Glovo reminders): reviews nobody answered for over an hour.
export async function remindGoogle(today: string, slot: string) {
  const { error: dup } = await db.from("bot_announcements").insert({ key: `google-remind-${today}-${slot}`, info: {} });
  if (dup) return { sent: 0, reason: "already sent this slot" };
  // Unanswered: came to the bot over an hour ago, or the last week's backlog (the same list as «Без відповіді» in the app).
  const hourAgo = new Date(Date.now() - 3600000).toISOString(), weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data } = await db.from("google_reviews").select(ROW + ",locations(name)").is("reply", null)
    .or(`notified_at.lt."${hourAgo}",and(notified_at.is.null,published_at.gt."${weekAgo}",published_at.lt."${hourAgo}")`)
    .or('result.is.null,result.neq."Відповідь не потрібна"')
    .order("published_at", { ascending: false }).limit(100);
  const rows = (data ?? []) as unknown as (GRow & { locations: { name: string } })[];
  if (!rows.length) return { sent: 0, waiting: 0 };
  const ago = (iso: string | null) => {
    if (!iso) return "";
    const h = Math.round((Date.now() - Date.parse(iso)) / 3600000);
    return h < 24 ? `${h} год тому` : `${Math.round(h / 24)} дн тому`;
  };
  const lines = rows.slice(0, 15).map((r) => `${r.rating ?? "?"}★ <b>${escH(r.locations.name)}</b> · ${escH(r.author || "без імені")} · ${ago(r.published_at)}`);
  if (rows.length > 15) lines.push(`…і ще ${rows.length - 15}`);
  const kb = rows.slice(0, 8).map((r) => [{ text: `${r.locations.name.replace(/^Львів, /, "")} · ${r.rating ?? "?"}★`, callback_data: `gr:${r.key}:w` }]);
  let sent = 0;
  // The day someone took the backlog («Я беру сьогодні»), only she gets the reminder.
  const { data: taken } = await db.from("bot_announcements").select("info").eq("key", `google-backlog-${today}`).maybeSingle();
  const taker = (taken?.info as { tg_id?: number } | null)?.tg_id;
  for (const u of (await recipients()).filter((x) => !taker || x.tg_id === taker)) {
    const res = await tg("sendMessage", {
      chat_id: u.tg_id, parse_mode: "HTML", reply_markup: { inline_keyboard: kb },
      text: `⏰ <b>Відгуки Google без відповіді: ${rows.length}</b>\n\n${lines.join("\n")}\n\nНатисніть, щоб відповісти:`,
    }).catch(console.error);
    if (res?.ok) sent++;
  }
  return { sent, waiting: rows.length };
}
