// The new Google reviews format, told to the communication team (owner 2026-11-25): three pictures in the morning of
// 26.11 with an «Ознайомилася» button. Until a person presses it, the bot asks again at every reminder slot
// (10:00 with the pictures, 14:00 and 18:00 with the button only).
import { db, tg, type User } from "./common.ts";
import { recipients } from "./uployal.ts";

const START = "2026-11-26";
const IMG = "https://kebabtsiaua-prog.github.io/kebabtsia-vidguky/img/google-intro-";
const ackKey = (tgId: number) => `google-intro-ack-${tgId}`;
const KB = { inline_keyboard: [[{ text: "✅ Ознайомилася", callback_data: "gi:0:ok" }]] };

export async function sendGoogleIntro(today: string, slot: string) {
  if (today < START) return { sent: 0, reason: "not yet" };
  let sent = 0, acked = 0;
  for (const u of await recipients()) {
    const { data: ack } = await db.from("bot_announcements").select("key").eq("key", ackKey(u.tg_id)).maybeSingle();
    if (ack) { acked++; continue; }
    const { error: dup } = await db.from("bot_announcements").insert({ key: `google-intro-${u.tg_id}-${today}-${slot}`, info: {} });
    if (dup) continue;
    const { count } = await db.from("bot_announcements").select("key", { count: "exact", head: true }).like("key", `google-intro-${u.tg_id}-%`);
    const first = (count ?? 0) <= 1;
    if (slot === "10") {
      await tg("sendMediaGroup", { chat_id: u.tg_id, media: [1, 2, 3].map((i) => ({ type: "photo", media: `${IMG}${i}.png` })) }).catch(console.error);
    }
    const text = first
      ? "📣 <b>Новий формат роботи з відгуками Google</b>\n\nВідтепер кожен новий відгук з Google приходить сюди, у бот, і відповідати можна прямо звідси. Гляньте 3 картинки вище, там усе коротко.\n\nКоли переглянете, натисніть кнопку нижче 👇"
      : slot === "10"
      ? "📣 Нагадуємо про новий формат роботи з відгуками Google: 3 картинки вище. Коли переглянете, натисніть кнопку 👇"
      : "📣 Ви ще не підтвердили, що ознайомилися з новим форматом відгуків Google (картинки надіслали зранку). Натисніть кнопку, коли переглянете 👇";
    const r = await tg("sendMessage", { chat_id: u.tg_id, parse_mode: "HTML", text, reply_markup: KB }).catch(console.error);
    if (r?.ok) sent++;
  }
  return { sent, acked };
}

// «Ознайомилася» pressed: no more reminders for this person; the owner hears about it.
export async function ackGoogleIntro(cb: { id: string }, chat: number, msgId: number, u: User, tellOwner: (t: string, about: number) => Promise<void>) {
  const { error } = await db.from("bot_announcements").insert({ key: ackKey(u.tg_id), info: { at: new Date().toISOString() } });
  await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Дякуємо!" });
  await tg("editMessageText", {
    chat_id: chat, message_id: msgId, parse_mode: "HTML",
    text: "✅ <b>Ознайомилася</b> з новим форматом відгуків Google. Дякуємо! Нові відгуки приходитимуть сюди карткою з кнопками.",
  }).catch(console.error);
  if (!error) await tellOwner(`✅ ${u.name} ознайомилася з новим форматом відгуків Google.`, u.tg_id);
}
