// Telegram webhook for @kebabtsia_vidguky_bot.
// A person sends a screenshot or text → AI fills location, channel and the complaint → buttons to fix and save.
// GET ?setup=1 (called by the deploy workflow) points the webhook and the menu button at this function.
import { b64, parseComplaint } from "../_shared/ai.ts";
import { listChats, onGroupMessage, onMembership } from "../_shared/uployal.ts";
import {
  activeLocations, APP_URL, bootstrapAdmin, channelsFor, db, getUser, kyivToday, type Location, redeemCode, ROLES,
  savePhoto, tg, tgFile, type User, webhookSecret,
} from "../_shared/common.ts";

type Draft = {
  loc: number | null;
  ch: string | null;
  text: string;
  date: string;
  topics: string[];
  rating: number | null;
  photo: string | null; // Telegram file_id
};

const PAGE = 10;
const openApp = { text: "📊 Відкрити апку", web_app: { url: APP_URL } };

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

function draftText(d: Draft, locs: Location[]): string {
  const loc = locs.find((l) => l.id === d.loc);
  const [y, m, day] = d.date.split("-");
  const lines = [
    "<b>Нова скарга</b>",
    `📍 Точка: ${loc ? esc(loc.name) : "<i>не визначено, виберіть кнопкою</i>"}`,
    `📣 Канал: ${d.ch ? esc(d.ch) : "<i>не визначено, виберіть кнопкою</i>"}`,
    `📅 Дата: ${day}.${m}.${y}${d.rating ? ` · ${"★".repeat(d.rating)}` : ""}`,
    `💬 ${esc(d.text || "(без тексту)")}`,
  ];
  if (d.topics.length) lines.push(`🏷 ${esc(d.topics.join(", "))}`);
  lines.push("", d.loc && d.ch ? "Усе вірно? Натисніть «Зберегти»." : "Виберіть точку і канал, потім «Зберегти».");
  return lines.join("\n");
}

function draftKeyboard(id: number, d: Draft, u: User) {
  const rows = [];
  if (d.loc && d.ch && d.text) rows.push([{ text: "✅ Зберегти", callback_data: `s:${id}` }]);
  const edit = [];
  if (u.role !== "loc_admin") edit.push({ text: "📍 Точка", callback_data: `lp:${id}:0` });
  edit.push({ text: "📣 Канал", callback_data: `c:${id}` });
  rows.push(edit);
  rows.push([{ text: "✖ Скасувати", callback_data: `x:${id}` }]);
  return { inline_keyboard: rows };
}

async function showDraft(chat: number, msgId: number | null, id: number, d: Draft, u: User) {
  const locs = await activeLocations();
  const body = { chat_id: chat, text: draftText(d, locs), parse_mode: "HTML", reply_markup: draftKeyboard(id, d, u) };
  if (msgId) await tg("editMessageText", { ...body, message_id: msgId });
  else await tg("sendMessage", body);
}

async function loadDraft(id: number, u: User): Promise<Draft | null> {
  const { data } = await db.from("bot_drafts").select("data").eq("id", id).eq("tg_id", u.tg_id).maybeSingle();
  return (data?.data as Draft) ?? null;
}
async function storeDraft(id: number, d: Draft) {
  await db.from("bot_drafts").update({ data: d }).eq("id", id);
}

// deno-lint-ignore no-explicit-any
async function onMessage(msg: any) {
  if (msg.chat?.type !== "private") return;
  const chat = msg.chat.id;
  const from = msg.from;
  const text: string = (msg.text ?? msg.caption ?? "").trim();
  let u = await getUser(from.id);

  if (text.startsWith("/start")) {
    const code = text.split(/\s+/)[1];
    if (!u) {
      try {
        u = await bootstrapAdmin(from);
      } catch (e) {
        console.error(e);
        await tg("sendMessage", { chat_id: chat, text: `Технічна помилка сервера: ${(e as Error).message}. Перешліть це повідомлення розробнику.` });
        return;
      }
    }
    if (!u && code) u = await redeemCode(code, from);
    if (!u) {
      await tg("sendMessage", { chat_id: chat, text: "Вітаю! Щоб користуватися ботом, потрібен код доступу. Попросіть його в адміністратора і надішліть сюди." });
      return;
    }
    await tg("sendMessage", {
      chat_id: chat,
      parse_mode: "HTML",
      text: `Вітаю, ${esc(u.name)}! Ваша роль: <b>${ROLES[u.role]}</b>.\n\n` +
        "Щоб додати скаргу, надішліть сюди скриншот або текст відгуку. Я сам визначу точку і канал, а ви підтвердите кнопкою.\n\n" +
        "Усі скарги, аналітика і рішення в апці.",
      reply_markup: { inline_keyboard: [[openApp]] },
    });
    return;
  }

  if (!u) {
    const joined = text ? await redeemCode(text, from) : null;
    await tg("sendMessage", joined
      ? { chat_id: chat, text: `Готово, доступ відкрито. Ваша роль: ${ROLES[joined.role]}. Надсилайте скриншоти скарг сюди.`, reply_markup: { inline_keyboard: [[openApp]] } }
      : { chat_id: chat, text: "Код не підходить. Попросіть новий код в адміністратора і надішліть його сюди." });
    return;
  }

  const photoId: string | null = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id
    : msg.document?.mime_type?.startsWith("image/") ? msg.document.file_id : null;
  if (!photoId && !text) {
    await tg("sendMessage", { chat_id: chat, text: "Надішліть скриншот або текст скарги." });
    return;
  }

  await tg("sendChatAction", { chat_id: chat, action: "typing" });
  const locs = await activeLocations();
  let image;
  if (photoId) {
    const f = await tgFile(photoId);
    image = { data: b64(f.bytes), mime: f.mime };
  }
  const p = await parseComplaint(locs, { text, image });
  const allowed = channelsFor(u.role);
  const d: Draft = {
    loc: u.role === "loc_admin" ? u.location_id : p.location_id,
    ch: p.channel && allowed.includes(p.channel) ? p.channel : allowed.length === 1 ? allowed[0] : null,
    text: p.text || text,
    date: p.date ?? kyivToday(),
    topics: p.topics,
    rating: p.rating,
    photo: photoId,
  };
  const { data } = await db.from("bot_drafts").insert({ tg_id: u.tg_id, data: d }).select("id").single();
  await showDraft(chat, null, data!.id, d, u);
}

// deno-lint-ignore no-explicit-any
async function onCallback(cb: any) {
  const u = await getUser(cb.from.id);
  const chat = cb.message?.chat?.id;
  const msgId = cb.message?.message_id;
  const [kind, idStr, arg] = String(cb.data ?? "").split(":");
  const id = Number(idStr);
  if (!u || !chat) return tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Немає доступу" });
  const d = await loadDraft(id, u);
  if (!d) {
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Ця чернетка вже неактуальна" });
    return;
  }

  if (kind === "x") {
    await db.from("bot_drafts").delete().eq("id", id);
    await tg("editMessageText", { chat_id: chat, message_id: msgId, text: "Скасовано." });
  } else if (kind === "v") {
    await showDraft(chat, msgId, id, d, u);
  } else if (kind === "lp") {
    const locs = await activeLocations();
    const page = Number(arg) || 0;
    const slice = locs.slice(page * PAGE, page * PAGE + PAGE);
    const rows = [];
    for (let i = 0; i < slice.length; i += 2) {
      rows.push(slice.slice(i, i + 2).map((l) => ({ text: l.name.replace("Львів, ", ""), callback_data: `ls:${id}:${l.id}` })));
    }
    const nav = [];
    if (page > 0) nav.push({ text: "← Назад", callback_data: `lp:${id}:${page - 1}` });
    if ((page + 1) * PAGE < locs.length) nav.push({ text: "Далі →", callback_data: `lp:${id}:${page + 1}` });
    if (nav.length) rows.push(nav);
    rows.push([{ text: "↩ До скарги", callback_data: `v:${id}` }]);
    await tg("editMessageText", { chat_id: chat, message_id: msgId, text: "Виберіть точку:", reply_markup: { inline_keyboard: rows } });
  } else if (kind === "ls") {
    if (u.role !== "loc_admin") d.loc = Number(arg);
    await storeDraft(id, d);
    await showDraft(chat, msgId, id, d, u);
  } else if (kind === "c") {
    const chs = channelsFor(u.role);
    const rows = [];
    for (let i = 0; i < chs.length; i += 2) {
      rows.push(chs.slice(i, i + 2).map((c, j) => ({ text: c, callback_data: `cs:${id}:${i + j}` })));
    }
    rows.push([{ text: "↩ До скарги", callback_data: `v:${id}` }]);
    await tg("editMessageText", { chat_id: chat, message_id: msgId, text: "Виберіть канал:", reply_markup: { inline_keyboard: rows } });
  } else if (kind === "cs") {
    d.ch = channelsFor(u.role)[Number(arg)] ?? d.ch;
    await storeDraft(id, d);
    await showDraft(chat, msgId, id, d, u);
  } else if (kind === "s") {
    if (!d.loc || !d.ch || !d.text) {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Спершу виберіть точку і канал" });
      return;
    }
    const { data: row, error } = await db.from("complaints").insert({
      location_id: d.loc, channel: d.ch, happened_on: d.date, text: d.text, topics: d.topics, rating: d.rating,
      source: "bot", created_by: u.tg_id,
    }).select("id").single();
    if (error) {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Не вдалося зберегти, спробуйте ще раз" });
      return;
    }
    await db.from("bot_drafts").delete().eq("id", id);
    if (d.photo) {
      const f = await tgFile(d.photo);
      await savePhoto(row.id, f.bytes, f.mime);
    }
    const locs = await activeLocations();
    await tg("editMessageText", {
      chat_id: chat,
      message_id: msgId,
      parse_mode: "HTML",
      text: `✅ Скаргу збережено\n📍 ${esc(locs.find((l) => l.id === d.loc)?.name ?? "")} · ${esc(d.ch)}\n💬 ${esc(d.text)}\n\nВона в апці у «Чекають рішення».`,
      reply_markup: { inline_keyboard: [[openApp]] },
    });
  }
  await tg("answerCallbackQuery", { callback_query_id: cb.id });
}

async function setup(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const self = `${Deno.env.get("SUPABASE_URL")}/functions/v1/bot`;
  const hook = await tg("setWebhook", {
    url: self,
    secret_token: await webhookSecret(),
    allowed_updates: ["message", "channel_post", "callback_query", "my_chat_member"],
    drop_pending_updates: false,
  });
  await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Відгуки", web_app: { url: APP_URL } } });
  await tg("setMyCommands", { commands: [{ command: "start", description: "Почати / відкрити апку" }] });
  await tg("setMyDescription", { description: "Скарги гостей Кебабці. Надішліть скриншот або текст відгуку, і бот додасть його в апку." });
  return Response.json({ ok: hook.ok, webhook: hook.description, host: url.host });
}

Deno.serve(async (req) => {
  try {
    if (req.method === "GET") {
      if (new URL(req.url).searchParams.has("chats")) return Response.json(await listChats());
      return await setup(req);
    }
    if (req.headers.get("x-telegram-bot-api-secret-token") !== await webhookSecret()) {
      return new Response("forbidden", { status: 403 });
    }
    const update = await req.json();
    const post = update.message ?? update.channel_post;
    if (post && post.chat?.type !== "private") await onGroupMessage(post);
    else if (update.message) await onMessage(update.message);
    else if (update.my_chat_member) await onMembership(update.my_chat_member);
    else if (update.callback_query) await onCallback(update.callback_query);
  } catch (e) {
    console.error(e);
  }
  return new Response("ok");
});
