// Reminders «за все» (owner 2026-11-02):
//  · a new complaint goes at once to whoever answers for it;
//  · every morning each person gets the list of their own complaints that still wait;
//  · three times a day operators and the comms managers are asked «Були нові скарги?» with [Немає] / [Додати].
import {
  activeLocations, APP_URL, canSolve, db, esc, getUser, INTERNAL_CHANNELS, itemUrl, kyivToday, LATE_DAYS, OPERATOR_CHANNELS, tabUrl, tg,
  type User, waitedDays,
} from "./common.ts";
import { recipients } from "./uployal.ts";

const short = (name: string) => name.replace(/^Львів, /, "");

// A complaint added by hand outside Glovo and Bolt (those have their own «беру в роботу» alert): Аня and Олена, and
// for the website and phone channels also the operators. The author is never told about their own complaint.
export async function notifyNew(id: number, skip?: number): Promise<number> {
  const { data: c } = await db.from("complaints").select("id,location_id,channel,text,created_by").eq("id", id).maybeSingle();
  if (!c) return 0;
  const { data: loc } = await db.from("locations").select("name").eq("id", c.location_id).maybeSingle();
  const { data: author } = c.created_by ? await db.from("users").select("name").eq("tg_id", c.created_by).maybeSingle() : { data: null };
  const to = new Set((await recipients()).map((r) => r.tg_id));
  if (OPERATOR_CHANNELS.includes(c.channel)) {
    const { data: ops } = await db.from("users").select("tg_id").eq("active", true).eq("role", "operator");
    for (const o of ops ?? []) to.add(o.tg_id);
  }
  to.delete(skip ?? -1);
  const text = [
    `🔴 <b>Нова скарга · ${esc(c.channel)}</b>`, "",
    `<b>Точка:</b> ${esc(loc?.name ?? "")}`,
    author ? `<b>Додав(ла):</b> ${esc(author.name)}` : "",
    `<blockquote>${esc(c.text)}</blockquote>`,
  ].filter(Boolean).join("\n");
  let sent = 0;
  for (const chat of to) {
    const r = await tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text, reply_markup: { inline_keyboard: [[{ text: "Відкрити скаргу", web_app: { url: itemUrl(c.id) } }]] } })
      .catch(console.error);
    if (r?.ok) sent++;
  }
  return sent;
}

// Every morning: a location admin gets the open Glovo, Bolt and app-rating complaints of their locations, an operator
// the website and phone ones. Аня and Олена get everything in the morning digest. Once per person per day.
export async function ownReminders(today = kyivToday()): Promise<number> {
  const { data: people } = await db.from("users").select("tg_id").eq("active", true).in("role", ["loc_admin", "operator"]);
  if (!people?.length) return 0;
  const locs = await activeLocations();
  const { data: open } = await db.from("complaints").select("id,location_id,channel,happened_on,created_at,source").eq("result", "")
    .in("channel", [...INTERNAL_CHANNELS, ...OPERATOR_CHANNELS]);
  let sent = 0;
  for (const p of people) {
    const u = await getUser(p.tg_id) as User;
    if (!u) continue;
    const mine = (open ?? []).filter((c) => locs.some((l) => l.id === c.location_id) && canSolve(u, c))
      .map((c) => ({ ...c, days: waitedDays(c, today) })).filter((c) => c.days >= 1).sort((a, b) => b.days - a.days);
    if (!mine.length) continue;
    const { error: dup } = await db.from("bot_announcements").insert({ key: `own-${u.tg_id}-${today}`, info: { n: mine.length } });
    if (dup) continue;
    const late = mine.filter((c) => c.days >= LATE_DAYS).length;
    const lines = [`⏰ <b>Ваші скарги чекають рішення: ${mine.length}</b>${late ? `, з них ${LATE_DAYS}+ днів: <b>${late}</b>` : ""}`, ""];
    for (const c of mine.slice(0, 10)) {
      lines.push(`${c.days >= LATE_DAYS ? "🔴" : "🟡"} №${c.id} ${esc(short(locs.find((l) => l.id === c.location_id)?.name ?? ""))}, ${esc(c.channel)} · ${c.days} дн`);
    }
    if (mine.length > 10) lines.push(`· і ще ${mine.length - 10}`);
    lines.push("", u.role === "loc_admin"
      ? "Перевірте по камерах і запишіть у скарзі, підтвердилось чи ні."
      : "Відкрийте скаргу, запишіть рішення і результат.");
    const r = await tg("sendMessage", {
      chat_id: u.tg_id, parse_mode: "HTML", text: lines.join("\n"),
      reply_markup: { inline_keyboard: [[{ text: "Відкрити мої скарги", web_app: { url: tabUrl("queue") } }]] },
    }).catch(console.error);
    if (r?.ok) sent++;
  }
  return sent;
}

// «Були нові скарги?» three times a day to the operators and to Аня and Олена (owner's idea, 2026-11-02).
// slot = «2026-11-02 12:00» in Kyiv time; one question per person per slot.
export async function sendCheckins(): Promise<Record<string, unknown>> {
  const now = new Date();
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", hour: "2-digit", hour12: false }).format(now);
  const slot = `${kyivToday()} ${hour}:00`;
  const { data: ops } = await db.from("users").select("tg_id").eq("active", true).eq("role", "operator");
  const to = new Set([...(ops ?? []).map((o) => o.tg_id), ...(await recipients()).map((r) => r.tg_id)]);
  let sent = 0;
  for (const chat of to) {
    const { error: dup } = await db.from("checkins").insert({ tg_id: chat, slot });
    if (dup) continue;
    const r = await tg("sendMessage", {
      chat_id: chat, parse_mode: "HTML",
      text: `🕐 <b>Були нові скарги?</b>\n\nПеревірте свої канали за останні години. Якщо скарг не було, натисніть «Немає». Якщо була, натисніть «Додати» або просто надішліть скриншот сюди.`,
      reply_markup: { inline_keyboard: [[{ text: "Немає", callback_data: `nn:${slot.replace(":", "")}` }, { text: "➕ Додати", web_app: { url: `${APP_URL}?add=1` } }]] },
    }).catch(console.error);
    if (r?.ok) {
      sent++;
      await db.from("checkins").update({ message_id: r.result.message_id }).eq("tg_id", chat).eq("slot", slot);
    }
  }
  return { ok: true, slot, sent };
}

// [Немає] pressed.
export async function answerNone(tgId: number, slotKey: string): Promise<string> {
  const slot = slotKey.slice(0, 13) + ":" + slotKey.slice(13);
  const { data } = await db.from("checkins").update({ answer: "none", answered_at: new Date().toISOString() })
    .eq("tg_id", tgId).eq("slot", slot).is("answered_at", null).select("message_id").maybeSingle();
  if (data?.message_id) {
    const at = new Date().toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" });
    await tg("editMessageText", { chat_id: tgId, message_id: data.message_id, text: `🕐 Були нові скарги? — Немає, відмічено о ${at}. Дякуємо!` }).catch(console.error);
  }
  return data ? "Дякуємо, відмічено" : "Уже відмічено";
}

// A complaint added after the question counts as the answer «додав(ла)».
export async function checkinAdded(tgId: number) {
  const since = new Date(Date.now() - 12 * 3600000).toISOString();
  const { data } = await db.from("checkins").select("slot,message_id").eq("tg_id", tgId).is("answered_at", null).gte("sent_at", since);
  for (const c of data ?? []) {
    await db.from("checkins").update({ answer: "added", answered_at: new Date().toISOString() }).eq("tg_id", tgId).eq("slot", c.slot);
    if (c.message_id) await tg("editMessageText", { chat_id: tgId, message_id: c.message_id, text: "🕐 Були нові скарги? — Так, скаргу додано. Дякуємо!" }).catch(console.error);
  }
}
