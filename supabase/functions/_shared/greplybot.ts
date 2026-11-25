// The bot side of replying to Google reviews: «✍️ Відповісти» asks for the text, «✨ Варіант відповіді» writes a draft,
// and nothing goes to Google until the person presses «✅ Надіслати в Google».
import { db, esc, tg, type User } from "./common.ts";
import { aiDraft, loadReview, mayReply, sendReply } from "./greviews.ts";

const confirmKb = (key: number) => ({
  inline_keyboard: [[{ text: "✅ Надіслати в Google", callback_data: `gr:${key}:s` }], [{ text: "✏️ Написати свій", callback_data: `gr:${key}:w` }, { text: "Скасувати", callback_data: `gr:${key}:x` }]],
});

async function showConfirm(chat: number, u: User, key: number, text: string, who: string) {
  const { data: old } = await db.from("google_reply_drafts").select("msg_id").eq("tg_id", u.tg_id).maybeSingle();
  if (old?.msg_id) await tg("editMessageReplyMarkup", { chat_id: chat, message_id: old.msg_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  const r = await tg("sendMessage", {
    chat_id: chat, parse_mode: "HTML", reply_markup: confirmKb(key),
    text: `<b>Відповідь</b> для ${esc(who)}:\n<blockquote>${esc(text)}</blockquote>\nНадіслати в Google? Можна також написати свій текст повідомленням у чат.`,
  });
  await db.from("google_reply_drafts").upsert({ tg_id: u.tg_id, review_key: key, text, awaiting: true, msg_id: r?.result?.message_id ?? null, created_at: new Date().toISOString() });
}

// Button presses with callback_data «gr:<key>:<w|ai|s|x>».
export async function onReviewButton(cb: { id: string }, chat: number, msgId: number, u: User, key: number, act: string) {
  const answer = (text = "") => tg("answerCallbackQuery", { callback_query_id: cb.id, text });
  if (!await mayReply(u)) return answer("Відповідають на відгуки Лена й Аня");
  const r = await loadReview(key);
  if (!r) return answer("Відгук не знайдено");
  const who = `${r.author || "гостя"} (${r.rating ?? "?"}★)`;
  if (act === "x") {
    await db.from("google_reply_drafts").delete().eq("tg_id", u.tg_id);
    await tg("editMessageText", { chat_id: chat, message_id: msgId, text: "Скасовано. Відповідь не надіслано." });
    return answer();
  }
  if (act === "w") {
    await db.from("google_reply_drafts").upsert({ tg_id: u.tg_id, review_key: key, text: null, awaiting: true, msg_id: null, created_at: new Date().toISOString() });
    await tg("sendMessage", {
      chat_id: chat, parse_mode: "HTML",
      text: `✍️ Напишіть відповідь для ${esc(who)} одним повідомленням.${r.reply ? "\n\nЗараз у Google:\n<blockquote>" + esc(r.reply) + "</blockquote>\nНова відповідь замінить її." : ""}`,
    });
    return answer();
  }
  if (act === "ai") {
    await answer("Пишу варіант…");
    await tg("sendChatAction", { chat_id: chat, action: "typing" });
    const text = await aiDraft(r);
    if (!text) {
      await tg("sendMessage", { chat_id: chat, text: "Не вийшло скласти варіант. Натисніть «✍️ Відповісти» і напишіть самі." });
      return;
    }
    await showConfirm(chat, u, key, text, who);
    return;
  }
  if (act === "s") {
    const { data: d } = await db.from("google_reply_drafts").select("text,review_key").eq("tg_id", u.tg_id).maybeSingle();
    if (!d?.text || d.review_key !== key) return answer("Ця чернетка вже неактуальна");
    try {
      await sendReply(r, d.text, u);
    } catch (e) {
      await tg("sendMessage", { chat_id: chat, text: `Не вдалося надіслати в Google: ${(e as Error).message}` });
      return answer();
    }
    await db.from("google_reply_drafts").delete().eq("tg_id", u.tg_id);
    await tg("editMessageText", { chat_id: chat, message_id: msgId, parse_mode: "HTML", text: `✅ <b>Відповідь надіслано в Google</b>\n<blockquote>${esc(d.text)}</blockquote>` });
    return answer("Надіслано");
  }
  return answer();
}

// A text message right after «✍️ Відповісти» (within 30 minutes): the reply to confirm. True when it was taken.
export async function onReviewText(chat: number, u: User, text: string): Promise<boolean> {
  const { data: d } = await db.from("google_reply_drafts").select("review_key,awaiting,created_at").eq("tg_id", u.tg_id).maybeSingle();
  if (!d?.awaiting || Date.now() - Date.parse(d.created_at) > 30 * 60000) return false;
  const r = await loadReview(d.review_key);
  if (!r) return false;
  await showConfirm(chat, u, r.key, text, `${r.author || "гостя"} (${r.rating ?? "?"}★)`);
  return true;
}
