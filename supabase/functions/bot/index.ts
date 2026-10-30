// Telegram webhook for @kebabtsia_vidguky_bot.
// A person sends a screenshot or text → AI fills location, channel and the complaint → buttons to fix and save.
// GET ?setup=1 (called by the deploy workflow) points the webhook and the menu button at this function.
import { syncSheet } from "../_shared/sheet.ts";
import { b64, parseComplaint } from "../_shared/ai.ts";
import { listChats, onGroupMessage, onMembership } from "../_shared/uployal.ts";
import {
  activeLocations, APP_URL, bootstrapAdmin, channelsFor, db, getUser, glovoKey, itemUrl, kyivToday, type Location, ownLocations, redeemCode, ROLES,
  savePhoto, tabUrl, tg, tgFile, type User, webhookSecret,
} from "../_shared/common.ts";
import { recipients } from "../_shared/uployal.ts";
import { alertTake, dailyReport, type ImportResult, importGlovo, isGlovoReport, remindGlovo, take, takeButtonFor } from "../_shared/glovo.ts";
import { FEEDBACK_BTN, FEEDBACK_KB, inviteText, locked, ownerId, setOf, type SurveyUser } from "../_shared/survey.ts";

type Draft = {
  loc: number | null;
  ch: string | null;
  text: string;
  date: string;
  topics: string[];
  rating: number | null;
  photo: string | null; // Telegram file_id
  msg?: number;          // the draft's message, to update it after the text is corrected
  awaitText?: boolean;   // «Текст» pressed: the next message from this person replaces the text
};

const PAGE = 10;
const openApp = { text: "📊 Відкрити апку", web_app: { url: APP_URL } };
const startBtn = (u: SurveyUser) => ({ text: setOf(u) === "tour" ? "Почати екскурсію" : "Почати", web_app: { url: APP_URL } });
async function tellOwner(text: string, about: number) {
  const id = await ownerId();
  if (id && id !== about) await tg("sendMessage", { chat_id: id, parse_mode: "HTML", text }).catch(console.error);
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

function draftText(d: Draft, locs: Location[]): string {
  const loc = locs.find((l) => l.id === d.loc);
  const [y, m, day] = d.date.split("-");
  const lines = [
    "✨ <b>Перевірте скаргу</b>",
    "",
    `<b>Точка:</b> ${loc ? esc(loc.name) : "<i>не визначено, виберіть кнопкою</i>"}`,
    `<b>Канал:</b> ${d.ch ? esc(d.ch) : "<i>не визначено, виберіть кнопкою</i>"}${d.rating ? ` · ${"★".repeat(d.rating)}` : ""}`,
    `<b>Дата:</b> ${day}.${m}.${y}`,
  ];
  if (d.topics.length) lines.push(`<b>Тема:</b> ${esc(d.topics.join(", "))}`);
  lines.push(`<blockquote>${esc(d.text || "(без тексту)")}</blockquote>`);
  lines.push(d.awaitText ? "✏️ Надішліть правильний текст скарги наступним повідомленням."
    : d.loc && d.ch ? "Усе вірно? ШІ нічого не зберігає сам, натисніть «Зберегти»." : "Виберіть точку і канал, потім «Зберегти».");
  return lines.join("\n");
}

function draftKeyboard(id: number, d: Draft, u: User) {
  const rows = [];
  if (d.loc && d.ch && d.text) rows.push([{ text: "✓ Зберегти", callback_data: `s:${id}` }]);
  const edit = [];
  if ((ownLocations(u)?.length ?? 2) > 1) edit.push({ text: "Точка", callback_data: `lp:${id}:0` });
  edit.push({ text: "Канал", callback_data: `c:${id}` });
  edit.push({ text: "Текст", callback_data: `t:${id}` });
  rows.push(edit);
  rows.push([{ text: "✖ Скасувати", callback_data: `x:${id}` }]);
  return { inline_keyboard: rows };
}

async function showDraft(chat: number, msgId: number | null, id: number, d: Draft, u: User) {
  const locs = await activeLocations();
  const body = { chat_id: chat, text: draftText(d, locs), parse_mode: "HTML", reply_markup: draftKeyboard(id, d, u) };
  if (msgId) await tg("editMessageText", { ...body, message_id: msgId });
  else {
    const sent = await tg("sendMessage", body);
    if (sent.result?.message_id) await storeDraft(id, { ...d, msg: sent.result.message_id });
  }
}

async function loadDraft(id: number, u: User): Promise<Draft | null> {
  const { data } = await db.from("bot_drafts").select("data").eq("id", id).eq("tg_id", u.tg_id).maybeSingle();
  return (data?.data as Draft) ?? null;
}
async function storeDraft(id: number, d: Draft) {
  await db.from("bot_drafts").update({ data: d }).eq("id", id);
}

// What the bot answers after a Glovo report is imported, from a forwarded file or from the Chrome extension.
function glovoSummary(r: ImportResult, via = "") {
  const dm = (d: string) => d.split("-").reverse().slice(0, 2).join(".");
  const lines = [`📥 <b>Звіт Glovo${r.days.length ? ` за ${r.days.map(dm).join(", ")}` : ""}</b>`, ""];
  if (via) lines.splice(1, 0, via);
  if (!r.rows) lines.push("У звіті немає відгуків.");
  else if (!r.fresh) lines.push(`Усі ${r.rows} відгуків уже були додані раніше.`);
  else {
    lines.push(`Нових відгуків: <b>${r.fresh}</b>, з них з текстом: <b>${r.withText}</b>, негативних: <b>${r.negative}</b>.`);
    if (r.complaints.length) {
      lines.push("", `Нові скарги (${r.complaints.length}):`);
      for (const c of r.complaints) lines.push(`· №${c.id} ${esc(c.loc)}`);
      lines.push("", "Адміни точок отримали сповіщення. Вам, Роману та Юрі завтра зранку прийде звіт за день.");
    } else lines.push("", "Нових скарг немає.");
    if (r.existing) lines.push(`Уже були в апці раніше: ${r.existing}.`);
  }
  if (r.unknown.length) lines.push("", `⚠️ Не знайшов точку для: ${r.unknown.map(esc).join("; ")}. Їхні скарги не додано, напишіть розробнику.`);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: [[{ text: "Відкрити чергу", web_app: { url: tabUrl("queue") } }]] } };
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
    const su = u as SurveyUser;
    if (locked(su)) {
      await tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: inviteText(su), reply_markup: { inline_keyboard: [[startBtn(su)]] } });
      await tg("sendMessage", { chat_id: chat, text: "Якщо маєте зауваження до апки, натисніть кнопку внизу.", reply_markup: FEEDBACK_KB });
      if (code && setOf(su) === "tour") await tellOwner(`👋 ${esc(u.name)} відкрив бота й отримав привітання та екскурсію.`, u.tg_id);
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
    await tg("sendMessage", { chat_id: chat, text: "Якщо маєте зауваження до апки, натисніть кнопку внизу.", reply_markup: FEEDBACK_KB });
    return;
  }

  if (!u) {
    const joined = text ? await redeemCode(text, from) : null;
    await tg("sendMessage", joined
      ? { chat_id: chat, text: `Готово, доступ відкрито. Ваша роль: ${ROLES[joined.role]}. Надсилайте скриншоти скарг сюди.`, reply_markup: { inline_keyboard: [[openApp]] } }
      : { chat_id: chat, text: "Код не підходить. Попросіть новий код в адміністратора і надішліть його сюди." });
    return;
  }

  // Remarks about the app: the button, then the next message (text or screenshot) within half an hour.
  const su = u as SurveyUser & { feedback_wait_at: string | null };
  if (text === FEEDBACK_BTN || text === "/feedback") {
    await db.from("users").update({ feedback_wait_at: new Date().toISOString() }).eq("tg_id", u.tg_id);
    await tg("sendMessage", { chat_id: chat, text: "Напишіть зауваження одним повідомленням: що незручно, що змінити, що додати. Можна прикласти скриншот.", reply_markup: FEEDBACK_KB });
    return;
  }
  if (su.feedback_wait_at && Date.now() - Date.parse(su.feedback_wait_at) < 30 * 60000 && (text || msg.photo)) {
    await db.from("users").update({ feedback_wait_at: null }).eq("tg_id", u.tg_id);
    await db.from("app_feedback").insert({ tg_id: u.tg_id, name: u.name, text: text || "(скриншот без тексту)" });
    await tg("sendMessage", { chat_id: chat, text: "Дякуємо! Зауваження збережено, ми його врахуємо.", reply_markup: FEEDBACK_KB });
    await syncSheet().catch(console.error);
    const { data: owner } = await db.from("users").select("tg_id").eq("survey_set", "none").eq("role", "admin").order("created_at").limit(1).maybeSingle();
    if (owner && owner.tg_id !== u.tg_id) {
      await tg("sendMessage", { chat_id: owner.tg_id, parse_mode: "HTML", text: `💬 <b>Зауваження до апки</b> від ${esc(u.name)}` }).catch(console.error);
      await tg("copyMessage", { chat_id: owner.tg_id, from_chat_id: chat, message_id: msg.message_id }).catch(console.error);
    }
    return;
  }
  // Survey not passed yet: complaints wait until the cabinet opens (owner 2026-10-24).
  if (locked(su) && setOf(su) !== "none") {
    await tg("sendMessage", {
      chat_id: chat, text: "Спершу пройдіть коротке знайомство з апкою, після нього можна буде додавати скарги.",
      reply_markup: { inline_keyboard: [[{ text: "Пройти опитування", web_app: { url: APP_URL } }]] },
    });
    return;
  }

  // «Текст» was pressed on a draft: this message is the corrected text.
  if (text && !msg.photo) {
    const { data: waiting } = await db.from("bot_drafts").select("id,data").eq("tg_id", u.tg_id).eq("data->>awaitText", "true")
      .gte("created_at", new Date(Date.now() - 6 * 3600000).toISOString()).order("id", { ascending: false }).limit(1).maybeSingle();
    if (waiting) {
      const d = { ...(waiting.data as Draft), text, awaitText: false };
      await storeDraft(waiting.id, d);
      if (d.msg) await tg("deleteMessage", { chat_id: chat, message_id: d.msg }).catch(() => {});
      await showDraft(chat, null, waiting.id, { ...d, msg: undefined }, u);
      return;
    }
  }

  // The key for the Chrome extension that sends the Glovo report by itself (owner 2026-10-30). Only the owner gets one.
  if (text === "/glovo_key") {
    await tg("sendMessage", u.role === "admin"
      ? { chat_id: chat, parse_mode: "HTML", text: "🧩 Ключ для розширення «Кебабця: звіт Glovo»:\n\n" +
        `<code>${await glovoKey(u.tg_id)}</code>\n\nНатисніть на ключ, щоб скопіювати, і вставте його в розширення. Нікому його не пересилайте.` }
      : { chat_id: chat, text: "Ключ для розширення Glovo видається лише власнику." });
    return;
  }

  // The Glovo «Відгуки щодня» report forwarded as a .csv file (owner 2026-10-30).
  if (msg.document && /\.csv$/i.test(msg.document.file_name ?? "")) {
    if (u.role !== "admin") {
      await tg("sendMessage", { chat_id: chat, text: "Звіти Glovo завантажує власник. Скарги надсилайте скриншотом або текстом." });
      return;
    }
    await tg("sendChatAction", { chat_id: chat, action: "typing" });
    const f = await tgFile(msg.document.file_id);
    const csv = new TextDecoder("utf-8").decode(f.bytes);
    if (!isGlovoReport(csv)) {
      await tg("sendMessage", { chat_id: chat, text: "Це не схоже на звіт Glovo «Відгуки щодня». Надішліть файл, завантажений зі звітів Glovo." });
      return;
    }
    await tg("sendMessage", { chat_id: chat, parse_mode: "HTML", ...glovoSummary(await importGlovo(csv)) });
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
  const own = ownLocations(u);
  const d: Draft = {
    loc: own ? (own.length === 1 ? own[0] : own.includes(p.location_id ?? -1) ? p.location_id : null) : p.location_id,
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
  // The owner takes back access from someone who joined through the shared link.
  if (kind === "rm") {
    if (u.role !== "admin" || !(u as SurveyUser).can_grant || id === u.tg_id) return tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Доступ міняють тільки власник, Роман і Юра" });
    const { data: x } = await db.from("users").update({ active: false }).eq("tg_id", id).select("name").maybeSingle();
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Доступ прибрано" });
    await tg("editMessageText", { chat_id: chat, message_id: msgId, text: `🚫 Доступ прибрано: ${x?.name ?? ""}. Ця людина більше не бачить апку.` });
    return;
  }
  if (kind === "tk") {
    const note = await take(id, u);
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: note });
    return;
  }
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
  } else if (kind === "t") {
    d.awaitText = true;
    await storeDraft(id, d);
    await showDraft(chat, msgId, id, d, u);
  } else if (kind === "lp") {
    const own = ownLocations(u);
    const locs = (await activeLocations()).filter((l) => !own || own.includes(l.id));
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
    if (!ownLocations(u) || ownLocations(u)!.includes(Number(arg))) d.loc = Number(arg);
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
      text: `✓ <b>Збережено · №${row.id}</b>\n${esc(locs.find((l) => l.id === d.loc)?.name ?? "")} · ${esc(d.ch)}\n<blockquote>${esc(d.text)}</blockquote>Скарга в апці у «Чекають рішення».`,
      reply_markup: d.ch === "Glovo" || d.ch === "Bolt" ? await takeButtonFor(row.id)
        : { inline_keyboard: [[{ text: "Відкрити скаргу", web_app: { url: itemUrl(row.id) } }]] },
    });
    // Glovo and Bolt: the location's other admins hear about it at once (owner 2026-10-27, 2026-10-30).
    if (d.ch === "Glovo" || d.ch === "Bolt") {
      await db.from("complaint_alerts").upsert({ complaint_id: row.id, chat_id: chat, message_id: msgId });
      await alertTake(row.id, u.tg_id);
    }
  }
  await tg("answerCallbackQuery", { callback_query_id: cb.id });
}

// Everyone invited before today who has not finished the survey and the tour gets one reminder a day (owner 2026-10-24).
async function surveyReminders(today: string): Promise<number> {
  const { data: users } = await db.from("users").select("*").eq("active", true).not("survey_due_at", "is", null).lt("survey_due_at", today);
  let n = 0;
  for (const u of (users ?? []) as SurveyUser[]) {
    if (!locked(u)) continue;
    const { error: dup } = await db.from("survey_reminders").insert({ tg_id: u.tg_id, day: today });
    if (dup) continue;
    const { count } = await db.from("survey_answers").select("q", { count: "exact", head: true }).eq("tg_id", u.tg_id);
    const text = u.survey_done_at ? "Лишилась коротка екскурсія по апці, 2 хвилини, і кабінет відкриється."
      : count ? `Ви відповіли на ${count} питань. Відповіді збережені, продовжуйте з того ж місця, і кабінет відкриється.`
      : "Ви ще не пройшли знайомство з апкою, тому кабінет закритий. Це близько 10 хвилин.";
    const r = await tg("sendMessage", {
      chat_id: u.tg_id, parse_mode: "HTML", text: `⏰ <b>Нагадування</b>\n\n${text}`,
      reply_markup: { inline_keyboard: [[{ text: "Продовжити", web_app: { url: APP_URL } }]] },
    }).catch(console.error);
    if (r?.ok) n++;
  }
  return n;
}

// GET ?digest=1, every morning from the «Ранкова зведенка» workflow: what waits for a decision (anything older than a day
// is listed, owner 2026-10-23) and where Google went down since the day before. Sent once a day, only when there is news.
const DAY = 86400000;
// Morning report for the people who lead the company (users.morning_report, owner 2026-10-26): yesterday at a glance,
// sent every day even when it was quiet, once per person per day.
async function morningReport(today: string): Promise<number> {
  const { data: to } = await db.from("users").select("tg_id").eq("active", true).eq("morning_report", true);
  if (!to?.length) return 0;
  const day = (n: number) => new Date(Date.parse(today) - n * DAY).toISOString().slice(0, 10);
  const y = day(1);
  const locs = await activeLocations();
  const name = (id: number) => (locs.find((l) => l.id === id)?.name ?? "").replace(/^Львів, /, "");
  const ua = (n: number, d = 1) => n.toFixed(d).replace(".", ",");
  const top = (xs: string[], k: number) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([x, n]) => `${esc(x)} ${n}`).join(", ");
  };
  const { data: fresh } = await db.from("complaints").select("location_id,channel").eq("happened_on", y);
  const { data: recent } = await db.from("complaints").select("resolved_at").gte("resolved_at", `${day(2)}T00:00:00Z`);
  const kyivDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date(iso));
  const solved = (recent ?? []).filter((c) => kyivDay(c.resolved_at) === y).length;
  const { data: openAll } = await db.from("complaints").select("location_id,happened_on").eq("result", "");
  const open = (openAll ?? []).filter((c) => locs.some((l) => l.id === c.location_id));
  const late = open.filter((c) => c.happened_on <= day(3)).length;
  const { data: rates } = await db.from("app_ratings").select("rating").eq("rated_on", y);
  const { data: snaps } = await db.from("google_daily").select("location_id,day,rating").gte("day", day(2)).order("day", { ascending: false });
  const month = y.slice(0, 8) + "01", prev = new Date(Date.parse(month) - DAY).toISOString().slice(0, 8) + "01";
  const prevSame = new Date(Date.parse(prev) + (Date.parse(y) - Date.parse(month))).toISOString().slice(0, 10);
  const { count: mtd } = await db.from("complaints").select("id", { count: "exact", head: true }).gte("happened_on", month).lte("happened_on", y);
  const { count: prevMtd } = await db.from("complaints").select("id", { count: "exact", head: true }).gte("happened_on", prev).lte("happened_on", prevSame);

  const f = fresh ?? [];
  const lines = [`☀️ <b>Відгуки за вчора, ${y.slice(8)}.${y.slice(5, 7)}</b>`, ""];
  lines.push(f.length ? `Нових скарг: <b>${f.length}</b> (${top(f.map((c) => c.channel), 4)})` : "Нових скарг: <b>0</b>");
  if (f.length) lines.push(`Найбільше: ${top(f.map((c) => name(c.location_id)), 3)}`);
  lines.push(`Вирішено за вчора: <b>${solved}</b>`);
  lines.push(`Чекають рішення: <b>${open.length}</b>${late ? `, з них довше 3 днів: <b>${late}</b>` : ""}`);
  const r = (rates ?? []).map((x) => x.rating);
  if (r.length) {
    const low = r.filter((x) => x <= 2).length;
    lines.push(`Оцінки в додатку: ${r.length}, середня <b>${ua(r.reduce((a, b) => a + b, 0) / r.length)}</b>${low ? `, низьких (1–2★): ${low}` : ""}`);
  }
  const g = (d: string) => (snaps ?? []).filter((s) => s.day === d && s.rating != null).map((s) => Number(s.rating));
  const gNow = g(today).length ? g(today) : g(y), gThen = g(today).length ? g(y) : g(day(2));
  if (gNow.length) {
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const diff = gThen.length ? avg(gNow) - avg(gThen) : 0;
    lines.push(`Google, середній по мережі: <b>${ua(avg(gNow), 2)}</b>${Math.abs(diff) >= 0.005 ? ` (${diff > 0 ? "+" : "−"}${ua(Math.abs(diff), 2)} за добу)` : ""}`);
  }
  lines.push("", `З початку місяця скарг: <b>${mtd ?? 0}</b>${prevMtd != null ? ` (минулого місяця за ті ж дні: ${prevMtd})` : ""}`);

  let sent = 0;
  for (const u of to) {
    const { error: dup } = await db.from("morning_reports").insert({ tg_id: u.tg_id, day: today });
    if (dup) continue;
    const res = await tg("sendMessage", {
      chat_id: u.tg_id, parse_mode: "HTML", text: lines.join("\n"),
      reply_markup: { inline_keyboard: [[{ text: "📊 Відкрити апку", web_app: { url: APP_URL } }]] },
    }).catch(console.error);
    if (res?.ok) sent++;
  }
  return sent;
}

async function digest(): Promise<Record<string, unknown>> {
  const today = kyivToday();
  const reminded = await surveyReminders(today);
  const reported = await morningReport(today).catch((e) => (console.error(e), 0));
  const glovo = await dailyReport(today).catch((e) => (console.error(e), 0));
  await syncSheet().catch(console.error);
  const { error: dup } = await db.from("bot_digests").insert({ day: today });
  if (dup) return { ok: true, sent: 0, reminded, reported, glovo, reason: "already sent today" };
  const locs = await activeLocations();
  const name = (id: number) => (locs.find((l) => l.id === id)?.name ?? "").replace(/^Львів, /, "");
  const { data: open } = await db.from("complaints").select("id,location_id,channel,happened_on,created_at,source").eq("result", "");
  const waited = (c: { happened_on: string; created_at: string; source: string }) => {
    const from = c.source === "sheet" ? c.happened_on : c.created_at.slice(0, 10) > c.happened_on ? c.created_at.slice(0, 10) : c.happened_on;
    return Math.round((Date.parse(today) - Date.parse(from)) / DAY);
  };
  const all = (open ?? []).filter((c) => locs.some((l) => l.id === c.location_id)).map((c) => ({ ...c, days: waited(c) })).sort((a, b) => b.days - a.days);
  const old = all.filter((c) => c.days >= 1);
  // Google: the two latest daily snapshots per location
  const { data: snaps } = await db.from("google_daily").select("location_id,day,rating").gte("day", new Date(Date.parse(today) - 3 * DAY).toISOString().slice(0, 10))
    .order("day", { ascending: false });
  const drops: string[] = [];
  for (const l of locs) {
    const s = (snaps ?? []).filter((x) => x.location_id === l.id && x.rating != null);
    if (s.length >= 2 && Number(s[0].rating) < Number(s[1].rating)) drops.push(`${esc(name(l.id))} ${String(s[1].rating).replace(".", ",")} → ${String(s[0].rating).replace(".", ",")}`);
  }
  if (!old.length && !drops.length) return { ok: true, sent: 0, reminded, reported, glovo, reason: "nothing to report" };
  const lines = ["☀️ <b>Ранкова зведенка</b>", ""];
  if (all.length) lines.push(`Чекають рішення: <b>${all.length}</b>${old.length ? `, з них довше доби: <b>${old.length}</b>` : ""}`);
  for (const c of old.slice(0, 8)) lines.push(`· ${esc(name(c.location_id))}, ${esc(c.channel)} · ${c.days} дн`);
  if (old.length > 8) lines.push(`· і ще ${old.length - 8}`);
  if (drops.length) lines.push("", `Google за добу впав: ${drops.slice(0, 6).join("; ")}${drops.length > 6 ? ` і ще ${drops.length - 6}` : ""}`);
  let sent = 0;
  for (const u of await recipients()) {
    const r = await tg("sendMessage", {
      chat_id: u.tg_id, parse_mode: "HTML", text: lines.join("\n"),
      reply_markup: { inline_keyboard: [[{ text: "Відкрити чергу", web_app: { url: tabUrl("queue") } }]] },
    }).catch(console.error);
    if (r?.ok) sent++;
  }
  return { ok: true, sent, reminded, reported, glovo, waiting: all.length, older: old.length, drops: drops.length };
}

// GET ?announce=KEY, called by the deploy workflow: a one-off message to one person, found by first name.
// Each key goes out once (bot_announcements); the reply carries counts only, because the deploy log is public.
const ANNOUNCE: Record<string, { who: RegExp; roles?: string[]; set?: string; text?: string; invite?: boolean }> = {
  // Аня and Олена, the comms managers (owner 2026-10-24 18:27): their survey, then the tour. They were added as
  // administrators, so the comms question set is pinned with survey_set and their rights stay as they are.
  "survey-start-anya": { who: /^(аня|анна|ганна|анюта|anya|anna|ania|hanna)(?![а-яіїєґa-z])/i, roles: ["comms", "admin"], set: "comm", invite: true },
  "survey-start-olena": { who: /^(олена|оленка|лена|olena|olenka|lena|elena)(?![а-яіїєґa-z])/i, roles: ["comms", "admin"], set: "comm", invite: true },
  // Юра, the CEO (owner 2026-10-26): a welcome and the tour, no questions. He had already signed up when this was built.
  "tour-start-yura": { who: /^(юра|юрій|юрко|yura|yurii|yuriy)(?![а-яіїєґa-z])/i, set: "tour", invite: true },
  // The survey is live: Роман goes first (owner 2026-10-24). Opens his survey and sends the start button.
  "survey-start-roman": { who: /^(роман|roman)(?![а-яіїєґa-z])/i, invite: true },
  "survey-roman": {
    who: /^(роман|roman)(?![а-яіїєґa-z])/i,
    text: [
      "👥 <b>Опитування команди</b>",
      "",
      "Романе, вітаємо! Ми запускаємо в «Відгуках» коротке опитування для всіх, хто працює зі скаргами: адмінів точок, операторок, Ані й Олени. Поки людина його не пройде, її кабінет закритий.",
      "",
      "<b>Ви пройдете першим.</b> Ваші 6 питань не про те, як є зараз, а про те, як має бути: які скарги доходять до вас, хто відповідає за скаргу, за який час її закривати, хто може дати компенсацію. З ваших відповідей складемо правила для всієї команди.",
      "",
      "Після вас попросимо вас написати адмінам, щоб вони теж пройшли. Коли все буде готово, бот надішле вам кнопку «Почати».",
    ].join("\n"),
  },
};
async function announce(key: string): Promise<Record<string, unknown>> {
  const a = ANNOUNCE[key];
  if (!a) return { ok: false, reason: "unknown key" };
  const { data: done } = await db.from("bot_announcements").select("key").eq("key", key).maybeSingle();
  if (done) return { ok: true, key, sent: 0, reason: "already sent" };
  const { data: users } = await db.from("users").select("tg_id,name,role").eq("active", true);
  const named = (users ?? []).filter((u) => a.who.test(u.name.trim()));
  const to = named.filter((u) => !a.roles || a.roles.includes(u.role));
  if (to.length !== 1) {
    // Roles only, never names: the deploy log is public.
    return { ok: false, key, sent: 0, found: to.length, same_name_roles: named.map((u) => u.role), reason: "expected exactly one person" };
  }
  if (a.invite) {
    const { data: x } = await db.from("users").select("*").eq("tg_id", to[0].tg_id).single();
    if (!x.survey_due_at || (a.set && !x.survey_set)) {
      await db.from("users").update({ survey_due_at: x.survey_due_at ?? new Date().toISOString(), ...(a.set && !x.survey_set ? { survey_set: a.set } : {}), ...(a.set === "tour" && !x.survey_done_at ? { survey_done_at: new Date().toISOString() } : {}) }).eq("tg_id", x.tg_id);
    }
  }
  const r = a.invite
    ? await tg("sendMessage", {
      chat_id: to[0].tg_id, parse_mode: "HTML", text: inviteText((await getUser(to[0].tg_id)) as SurveyUser),
      reply_markup: { inline_keyboard: [[startBtn((await getUser(to[0].tg_id)) as SurveyUser)]] },
    })
    : await tg("sendMessage", { chat_id: to[0].tg_id, parse_mode: "HTML", text: a.text });
  if (!r?.ok) return { ok: false, key, sent: 0, reason: r?.description ?? "telegram error" };
  await db.from("bot_announcements").insert({ key, info: { message_id: r.result?.message_id } });
  if (a.set === "tour") await tellOwner(`👋 ${esc(to[0].name)} отримав привітання й кнопку екскурсії.`, to[0].tg_id);
  return { ok: true, key, sent: 1 };
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
  await tg("setMyCommands", { commands: [{ command: "start", description: "Почати / відкрити апку" }, { command: "feedback", description: "Зауваження до апки" }] });
  await tg("setMyDescription", { description: "Скарги гостей Кебабці. Надішліть скриншот або текст відгуку, і бот додасть його в апку." });
  return Response.json({ ok: hook.ok, webhook: hook.description, host: url.host });
}

// The Chrome extension on the owner's computer sends the report it downloaded from the Glovo portal.
// Without a file it sends only what it saw on the page, so the auto-download can be fixed from the logs.
async function glovoUpload(req: Request): Promise<Response> {
  const key = req.headers.get("x-glovo-key")?.trim() ?? "";
  const tgId = Number(key.split(".")[0]);
  const u = tgId ? await getUser(tgId) : null;
  if (!u?.active || u.role !== "admin" || key !== await glovoKey(tgId)) return Response.json({ ok: false, error: "key" }, { status: 403 });
  const { csv, diag } = await req.json().catch(() => ({}));
  console.log("glovo extension", JSON.stringify(diag ?? null).slice(0, 16000));
  if (csv === undefined) return Response.json({ ok: true, logged: true });
  if (typeof csv !== "string" || !isGlovoReport(csv)) return Response.json({ ok: false, error: "not a report" }, { status: 400 });
  const r = await importGlovo(csv);
  await tg("sendMessage", { chat_id: u.tg_id, parse_mode: "HTML", ...glovoSummary(r, "🧩 Розширення Chrome забрало звіт саме.") });
  return Response.json({ ok: true, days: r.days, rows: r.rows, fresh: r.fresh, complaints: r.complaints.length });
}

Deno.serve(async (req) => {
  try {
    if (req.method === "POST" && new URL(req.url).searchParams.has("glovo_csv")) return await glovoUpload(req);
    if (req.method === "GET") {
      if (new URL(req.url).searchParams.has("chats")) return Response.json(await listChats());
      if (new URL(req.url).searchParams.has("digest")) return Response.json(await digest());
      if (new URL(req.url).searchParams.has("sheet")) return Response.json(await syncSheet());
      if (new URL(req.url).searchParams.has("glovo")) return Response.json(await remindGlovo(kyivToday()));
      if (new URL(req.url).searchParams.has("report")) return Response.json({ ok: true, reported: await morningReport(kyivToday()) });
      const key = new URL(req.url).searchParams.get("announce");
      if (key) return Response.json(await announce(key));
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
