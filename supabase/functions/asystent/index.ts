// Telegram webhook for the personal assistant bot (stage 1: conversation, reminders, memory).
// The bot has its own token (ASYSTENT_BOT_TOKEN), so it never mixes with @kebabtsia_vidguky_bot.
// GET ?setup=1 (deploy workflow) points the webhook at this function; GET ?tick=1 (pg_cron, every minute) sends what is due.
import Anthropic from "npm:@anthropic-ai/sdk@0.133.0";
import { b64 } from "../_shared/ai.ts";
import { activeLocations, db, esc } from "../_shared/common.ts";
import { PROMPT } from "./prompt.ts";
import { DAYS, fmt, fromKyiv, kyiv, kyivDay, nextTime, parseRepeat, parseWhen, two } from "./time.ts";

const HOUR = 3600_000;
const MAX_NAGS = 3;
const HISTORY = 16;

// ---------- Telegram ----------

function token(): string {
  return Deno.env.get("ASYSTENT_BOT_TOKEN")?.trim() ?? "";
}

async function tg(method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) console.error("telegram", method, json.description);
  return json;
}

// HTML first; if Telegram rejects the tags the model wrote, the same text goes without them.
async function send(chat: number, text: string, keyboard?: unknown[][]) {
  const markup = keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {};
  let out = await tg("sendMessage", { chat_id: chat, text: text.slice(0, 4000), parse_mode: "HTML", ...markup });
  if (!out.ok) out = await tg("sendMessage", { chat_id: chat, text: text.replace(/<[^>]+>/g, "").slice(0, 4000), ...markup });
  return out.result?.message_id as number | undefined;
}

async function webhookSecret(): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode("kebabtsia-asystent"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(token())));
  return Array.from(sig, (x) => x.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

async function tgFile(fileId: string): Promise<{ bytes: Uint8Array; path: string }> {
  const info = await tg("getFile", { file_id: fileId });
  const path: string = info.result.file_path;
  const res = await fetch(`https://api.telegram.org/file/bot${token()}/${path}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), path };
}

// ---------- Data ----------

type Person = { tg_id: number; name: string; role: string };
type Reminder = { id: number; tg_id: number; text: string; due_at: string; repeat: string | null; status: string; nags: number; msg_id: number | null };

async function person(id: number): Promise<Person | null> {
  const { data } = await db.from("as_people").select("*").eq("tg_id", id).maybeSingle();
  return data as Person | null;
}

// The very first person to press /start owns the bot; nobody else gets in at stage 1.
// deno-lint-ignore no-explicit-any
async function claimOwner(from: any): Promise<Person | null> {
  const { count } = await db.from("as_people").select("tg_id", { count: "exact", head: true });
  if (count !== 0) return null;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "Власник";
  const { data } = await db.from("as_people").insert({ tg_id: from.id, name, role: "owner" }).select().single();
  return data as Person | null;
}

async function kvGet<T>(key: string): Promise<T | null> {
  const { data } = await db.from("as_kv").select("value").eq("key", key).maybeSingle();
  return (data?.value as T) ?? null;
}
async function kvSet(key: string, value: unknown) {
  await db.from("as_kv").upsert({ key, value, updated_at: new Date().toISOString() });
}

async function openReminders(tgId: number): Promise<Reminder[]> {
  const { data } = await db.from("as_reminders").select("*").eq("tg_id", tgId).in("status", ["pending", "sent"]).order("due_at").limit(50);
  return (data ?? []) as Reminder[];
}

function reminderLine(r: Reminder): string {
  return `${r.status === "sent" ? "✱" : "○"} ${fmt(new Date(r.due_at))} ${esc(r.text)}${r.repeat ? ` <i>(${esc(r.repeat)})</i>` : ""}`;
}

// A done, missed or cancelled repeat puts the next one in the plan.
async function scheduleNext(r: Reminder) {
  const rule = r.repeat && parseRepeat(r.repeat);
  const due = rule && nextTime(rule, new Date(Math.max(Date.now(), new Date(r.due_at).getTime())));
  if (due) await db.from("as_reminders").insert({ tg_id: r.tg_id, text: r.text, due_at: due.toISOString(), repeat: r.repeat });
}

// ---------- The brain ----------

async function system(tgId: number) {
  const locs = await activeLocations();
  const { data: mem } = await db.from("as_memory").select("topic,fact").order("topic");
  const now = new Date();
  const p = kyiv(now);
  const open = await openReminders(tgId);
  const month = `${p.y}-${two(p.m)}-01`;
  const { data: closed } = await db.from("as_reminders").select("status").eq("tg_id", tgId).gte("closed_at", fromKyiv(p.y, p.m, 1, 0, 0).toISOString());
  const done = (closed ?? []).filter((r) => r.status === "done").length;
  const missed = (closed ?? []).filter((r) => r.status === "missed").length;
  const { data: missedRows } = await db.from("as_reminders").select("id,text,due_at").eq("tg_id", tgId).eq("status", "missed")
    .gte("closed_at", new Date(now.getTime() - 3 * 24 * HOUR).toISOString()).order("due_at");
  const missedLately = (missedRows ?? []) as Pick<Reminder, "id" | "text" | "due_at">[];
  const data = [
    `Зараз у Києві: ${DAYS[p.wd]}, ${two(p.d)}.${two(p.m)}.${p.y} ${two(p.h)}:${two(p.mi)}.`,
    `Відкриті нагадування (${open.length}):`,
    ...open.map((r) => `- [${r.id}] ${fmt(new Date(r.due_at))} ${r.text}${r.repeat ? ` (${r.repeat})` : ""}${r.status === "sent" ? " — надіслано, чекає «Зроблено»" : ""}`),
    `Пропущені за 3 дні: ${missedLately.map((r) => `[${r.id}] ${fmt(new Date(r.due_at))} ${r.text}`).join("; ") || "немає"}.`,
    `Цього місяця (з ${month}, бот): зроблено ${done}, пропущено ${missed}.`,
  ].join("\n");
  // The prompt, locations and memory change rarely and are cached; the data block (time, reminders) goes after them.
  const [stable] = PROMPT
    .replace("{{ЛОКАЦІЇ}}", locs.map((l) => `- ${l.name}${l.aliases?.length ? ` (також: ${l.aliases.join(", ")})` : ""}`).join("\n"))
    .replace("{{ПАМʼЯТЬ}}", (mem ?? []).map((m) => `- ${m.topic}: ${m.fact}`).join("\n") || "(поки порожньо)")
    .split("{{ДАНІ}}");
  return [
    { type: "text", text: stable, cache_control: { type: "ephemeral" } },
    { type: "text", text: data },
  ];
}

type Content = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

async function think(tgId: number, content: Content[]): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return "Мозок ще не підключений: немає ключа ANTHROPIC_API_KEY у Supabase → Edge Functions → Secrets.";
  const { data: past } = await db.from("as_messages").select("role,content").eq("tg_id", tgId).order("id", { ascending: false }).limit(HISTORY);
  // deno-lint-ignore no-explicit-any
  const messages: any[] = (past ?? []).reverse().map((m) => ({ role: m.role, content: m.content }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  messages.push({ role: "user", content });
  try {
    const client = new Anthropic({ apiKey });
    // deno-lint-ignore no-explicit-any
    const params: any = {
      model: "claude-opus-5-5",
      max_tokens: 3000,
      system: await system(tgId),
      messages,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
    const res = await client.beta.messages.create(params);
    if (res.stop_reason === "refusal") return "Не можу з цим допомогти. Спробуй сформулювати інакше.";
    // deno-lint-ignore no-explicit-any
    return res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
  } catch (e) {
    console.error("anthropic", e);
    return "Не вдалося отримати відповідь від мозку (Claude API). Спробуй ще раз за хвилину.";
  }
}

// Service lines at the end of the answer (#нагадати, #запамʼятати, #кнопки) are carried out and hidden.
async function carryOut(tgId: number, answer: string): Promise<{ text: string; keyboard: unknown[][] }> {
  const keep: string[] = [];
  const notes: string[] = [];
  const keyboard: unknown[][] = [];
  for (const line of answer.split("\n")) {
    const m = line.trim().match(/^#(нагадати|закрити|запа[мʼ'’]?ятати|кнопки|crm|нова_тема)\s*:\s*(.*)$/i);
    if (!m) {
      keep.push(line);
      continue;
    }
    const [cmd, args] = [m[1].toLowerCase(), m[2]];
    const parts = args.split("|").map((s) => s.trim());
    if (cmd === "нагадати") {
      const when = parseWhen(parts[0] ?? "");
      const text = parts.slice(2).join(" | ") || parts[1] || "";
      if (!when || !text) {
        notes.push(`Не зрозумів час нагадування «${esc(parts[0] ?? "")}». Напиши, наприклад, «29.10 о 18:00».`);
        continue;
      }
      const { data } = await db.from("as_reminders").insert({ tg_id: tgId, text, due_at: when.due.toISOString(), repeat: when.repeat }).select().single();
      notes.push(`Поставив нагадування: <b>${fmt(when.due)}</b> ${esc(text)}${when.repeat ? ` (${esc(when.repeat)})` : ""}`);
      if (data) keyboard.push([{ text: `✖ Скасувати «${text.slice(0, 24)}»`, callback_data: `x:${data.id}` }]);
    } else if (cmd === "закрити") {
      // «#закрити: 12 | зроблено» or «… | скасувати»: the owner said it in words instead of pressing the button.
      const id = Number(parts[0]);
      const status = /скас/i.test(parts[1] ?? "") ? "cancelled" : "done";
      const { data } = await db.from("as_reminders").update({ status, closed_at: new Date().toISOString() })
        .eq("id", id).eq("tg_id", tgId).in("status", ["pending", "sent", "missed"]).select().maybeSingle();
      const r = data as Reminder | null;
      if (!r) {
        notes.push("Не знайшов такого відкритого нагадування.");
        continue;
      }
      if (r.msg_id) await tg("editMessageReplyMarkup", { chat_id: tgId, message_id: r.msg_id, reply_markup: { inline_keyboard: [] } });
      if (status === "done") await scheduleNext(r);
      notes.push(`${status === "done" ? "✓ Позначив зроблено" : "Скасував"}: ${esc(r.text)}`);
    } else if (cmd.startsWith("запа")) {
      const [topic, ...fact] = parts;
      if (topic && fact.length) {
        await db.from("as_memory").upsert({ topic, fact: fact.join(" | "), updated_at: new Date().toISOString() });
        notes.push(`Запамʼятав: ${esc(topic)}`);
      }
    } else if (cmd === "кнопки") {
      const options = parts.filter(Boolean).slice(0, 6);
      await kvSet(`buttons:${tgId}`, options);
      options.forEach((o, i) => keyboard.unshift([{ text: o.slice(0, 60), callback_data: `b:${i}` }]));
    }
    // #crm and #нова_тема: stage 2. The prompt tells the model not to write them; if it does, they are dropped.
  }
  const text = [keep.join("\n").trim(), notes.join("\n")].filter(Boolean).join("\n\n");
  return { text: text || "Готово.", keyboard };
}

async function converse(chat: number, tgId: number, content: Content[], logText: string) {
  await tg("sendChatAction", { chat_id: chat, action: "typing" });
  const answer = await think(tgId, content);
  const { text, keyboard } = await carryOut(tgId, answer);
  await db.from("as_messages").insert([
    { tg_id: tgId, role: "user", content: logText },
    { tg_id: tgId, role: "assistant", content: answer },
  ]);
  await send(chat, text, keyboard);
}

// ---------- Messages ----------

const HELP = "Пиши мені як колезі: «нагадай завтра о 18:00 відправити пуш групі 211», «що в мене на четвер?», «запамʼятай: …».\n\n" +
  "/plan — усі нагадування\n/pamyat — що я памʼятаю\n\nЩоб передати мені памʼять проєкту, надішли .txt файл, де кожен рядок: <code>тема | факт</code>.";

// deno-lint-ignore no-explicit-any
async function onMessage(msg: any) {
  if (msg.chat?.type !== "private") return;
  const chat = msg.chat.id;
  const text: string = (msg.text ?? msg.caption ?? "").trim();
  let me = await person(msg.from.id);
  if (!me && text.startsWith("/start")) me = await claimOwner(msg.from);
  if (!me) {
    await send(chat, "Це особистий бот-асистент. Доступ видає власник бота.");
    return;
  }
  if (text.startsWith("/start")) {
    await send(chat, `Привіт, ${esc(me.name)}! Я твій асистент Кебабці. Нагадую про пуші й задачі, поки не натиснеш «Зроблено».\n\n${HELP}`);
    return;
  }
  if (text.startsWith("/plan")) {
    const open = await openReminders(me.tg_id);
    await send(chat, open.length ? `<b>Нагадування (${open.length})</b>\n${open.map(reminderLine).join("\n")}\n\n✱ надіслано, чекає «Зроблено» · ○ ще попереду` : "Нагадувань немає.");
    return;
  }
  if (text.startsWith("/pamyat")) {
    const { data } = await db.from("as_memory").select("topic,fact").order("topic");
    const lines = (data ?? []).map((m) => `<b>${esc(m.topic)}</b>: ${esc(m.fact)}`);
    await send(chat, lines.length ? `<b>Памʼять (${lines.length})</b>\n${lines.join("\n").slice(0, 3500)}` : "Памʼять порожня.");
    return;
  }
  if (msg.document) {
    await onDocument(chat, me, msg.document);
    return;
  }
  if (msg.voice || msg.audio || msg.video_note) {
    await send(chat, "Голосові поки не розбираю. Натисни на голосове → «Розшифрувати» в Телеграмі і перешли текст, або напиши коротко.");
    return;
  }
  if (msg.photo?.length) {
    const { bytes, path } = await tgFile(msg.photo[msg.photo.length - 1].file_id);
    const mime = path.endsWith(".png") ? "image/png" : "image/jpeg";
    await converse(chat, me.tg_id, [
      { type: "image", source: { type: "base64", media_type: mime, data: b64(bytes) } },
      { type: "text", text: text || "Ось скриншот. Що з ним зробити?" },
    ], `[скриншот] ${text}`);
    return;
  }
  if (text) await converse(chat, me.tg_id, [{ type: "text", text }], text);
}

// A .txt file with «тема | факт» lines becomes memory after «Так».
// deno-lint-ignore no-explicit-any
async function onDocument(chat: number, me: Person, doc: any) {
  if (!/\.(txt|md)$/i.test(doc.file_name ?? "")) {
    await send(chat, "Поки читаю тільки .txt файли з памʼяттю (рядок: тема | факт).");
    return;
  }
  const { bytes } = await tgFile(doc.file_id);
  const rows = new TextDecoder().decode(bytes).split("\n")
    .map((l) => l.split("|").map((s) => s.trim()))
    .filter((p) => p.length >= 2 && p[0] && p.slice(1).join(" | "))
    .map((p) => ({ topic: p[0].slice(0, 120), fact: p.slice(1).join(" | ") }));
  if (!rows.length) {
    await send(chat, "У файлі немає рядків виду «тема | факт».");
    return;
  }
  await kvSet(`import:${me.tg_id}`, rows);
  const preview = rows.slice(0, 8).map((r) => `• <b>${esc(r.topic)}</b>: ${esc(r.fact.slice(0, 120))}`).join("\n");
  await send(chat, `Знайшов ${rows.length} записів для памʼяті. Теми, що вже є, оновлю.\n\n${preview}${rows.length > 8 ? `\n… і ще ${rows.length - 8}` : ""}\n\nЗберегти?`, [
    [{ text: "✓ Так", callback_data: "mi:yes" }, { text: "✖ Скасувати", callback_data: "mi:no" }],
  ]);
}

// deno-lint-ignore no-explicit-any
async function onCallback(cb: any) {
  const me = await person(cb.from.id);
  const chat = cb.message?.chat?.id;
  const msgId = cb.message?.message_id;
  if (!me || !chat) {
    await tg("answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }
  const [kind, arg] = String(cb.data).split(":");
  const edit = (text: string) => tg("editMessageText", { chat_id: chat, message_id: msgId, text, parse_mode: "HTML" });

  if (kind === "b") {
    const options = (await kvGet<string[]>(`buttons:${me.tg_id}`)) ?? [];
    await tg("answerCallbackQuery", { callback_query_id: cb.id });
    const choice = options[+arg];
    if (choice) {
      await tg("editMessageReplyMarkup", { chat_id: chat, message_id: msgId, reply_markup: { inline_keyboard: [] } });
      await send(chat, `<i>Обрано: ${esc(choice)}</i>`);
      await converse(chat, me.tg_id, [{ type: "text", text: choice }], choice);
    }
    return;
  }
  if (kind === "mi") {
    const rows = await kvGet<{ topic: string; fact: string }[]>(`import:${me.tg_id}`);
    if (arg === "yes" && rows?.length) {
      const now = new Date().toISOString();
      await db.from("as_memory").upsert(rows.map((r) => ({ ...r, updated_at: now })));
      await edit(`✓ Зберіг у памʼять ${rows.length} записів.`);
    } else await edit("Скасовано, памʼять не змінена.");
    await db.from("as_kv").delete().eq("key", `import:${me.tg_id}`);
    await tg("answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  const { data } = await db.from("as_reminders").select("*").eq("id", +arg).eq("tg_id", me.tg_id).maybeSingle();
  const r = data as Reminder | null;
  if (!r || !["pending", "sent"].includes(r.status)) {
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Це нагадування вже закрите." });
    return;
  }
  const now = new Date();
  if (kind === "d") {
    await db.from("as_reminders").update({ status: "done", closed_at: now.toISOString() }).eq("id", r.id);
    await scheduleNext(r);
    await edit(`✓ <b>Зроблено</b> о ${fmt(now).slice(6)}: ${esc(r.text)}`);
  } else if (kind === "s") {
    const due = new Date(now.getTime() + HOUR);
    await db.from("as_reminders").update({ status: "pending", due_at: due.toISOString(), nags: 0 }).eq("id", r.id);
    await edit(`○ Нагадаю о ${fmt(due).slice(6)}: ${esc(r.text)}`);
  } else if (kind === "t") {
    const p = kyiv(new Date(r.due_at));
    const t = kyiv(new Date(now.getTime() + 24 * HOUR));
    const due = fromKyiv(t.y, t.m, t.d, p.h, p.mi);
    await db.from("as_reminders").update({ status: "pending", due_at: due.toISOString(), nags: 0 }).eq("id", r.id);
    await edit(`○ Перенесено на ${fmt(due)}: ${esc(r.text)}`);
  } else if (kind === "x") {
    await db.from("as_reminders").update({ status: "cancelled", closed_at: now.toISOString() }).eq("id", r.id);
    await tg("editMessageReplyMarkup", { chat_id: chat, message_id: msgId, reply_markup: { inline_keyboard: [] } });
    await send(chat, `Скасував нагадування: ${esc(r.text)}`);
  }
  await tg("answerCallbackQuery", { callback_query_id: cb.id });
}

// ---------- Every minute ----------

const reminderButtons = (id: number) => [
  [{ text: "✓ Зроблено", callback_data: `d:${id}` }],
  [{ text: "+1 година", callback_data: `s:${id}` }, { text: "Завтра", callback_data: `t:${id}` }],
];

async function tick() {
  if (!token()) return { ok: false, reason: "ASYSTENT_BOT_TOKEN is not set" };
  const now = Date.now();
  let sent = 0, nagged = 0, missed = 0;

  const { data: due } = await db.from("as_reminders").select("*").eq("status", "pending").lte("due_at", new Date(now).toISOString()).limit(30);
  for (const r of (due ?? []) as Reminder[]) {
    const id = await send(r.tg_id, `<b>Нагадування</b>\n${esc(r.text)}`, reminderButtons(r.id));
    await db.from("as_reminders").update({ status: "sent", nags: 0, msg_id: id ?? null, due_at: new Date(now).toISOString() }).eq("id", r.id);
    sent++;
  }

  // Not pressed «Зроблено»: again every hour, then it counts as missed.
  const { data: waiting } = await db.from("as_reminders").select("*").eq("status", "sent").limit(100);
  for (const r of (waiting ?? []) as Reminder[]) {
    if (new Date(r.due_at).getTime() + (r.nags + 1) * HOUR > now) continue;
    if (r.msg_id) await tg("editMessageReplyMarkup", { chat_id: r.tg_id, message_id: r.msg_id, reply_markup: { inline_keyboard: [] } });
    if (r.nags >= MAX_NAGS) {
      await db.from("as_reminders").update({ status: "missed", closed_at: new Date(now).toISOString() }).eq("id", r.id);
      await send(r.tg_id, `Позначив як пропущене: ${esc(r.text)}\nЯкщо все ж зробив, напиши мені, і я виправлю.`);
      await scheduleNext(r);
      missed++;
      continue;
    }
    const id = await send(r.tg_id, `<b>Ще не позначено «Зроблено»</b> (${r.nags + 1}/${MAX_NAGS})\n${esc(r.text)}`, reminderButtons(r.id));
    await db.from("as_reminders").update({ nags: r.nags + 1, msg_id: id ?? null }).eq("id", r.id);
    nagged++;
  }

  return { ok: true, sent, nagged, missed, digest: await morning() };
}

// At 9:00 Kyiv: today's plan, and on the 1st the last month's done/missed. Once a day.
async function morning(): Promise<string> {
  const now = new Date();
  const p = kyiv(now);
  const today = kyivDay(now);
  if (p.h < 9 || (await kvGet<string>("digest")) === today) return "not now";
  await kvSet("digest", today);
  const { data: people } = await db.from("as_people").select("tg_id");
  const end = fromKyiv(p.y, p.m, p.d, 23, 59);
  for (const { tg_id } of people ?? []) {
    const open = (await openReminders(tg_id)).filter((r) => new Date(r.due_at) <= end);
    const lines = [`<b>Доброго ранку! ${DAYS[p.wd]}, ${two(p.d)}.${two(p.m)}</b>`];
    lines.push(open.length ? `Сьогодні:\n${open.map(reminderLine).join("\n")}` : "На сьогодні нагадувань немає.");
    if (p.d === 1) {
      const from = fromKyiv(p.m === 1 ? p.y - 1 : p.y, p.m === 1 ? 12 : p.m - 1, 1, 0, 0);
      const { data: closed } = await db.from("as_reminders").select("status").eq("tg_id", tg_id)
        .gte("closed_at", from.toISOString()).lt("closed_at", fromKyiv(p.y, p.m, 1, 0, 0).toISOString());
      const done = (closed ?? []).filter((r) => r.status === "done").length;
      const miss = (closed ?? []).filter((r) => r.status === "missed").length;
      lines.push(`\n<b>Минулий місяць:</b> зроблено ${done}, пропущено ${miss}.`);
    }
    await send(tg_id, lines.join("\n"));
  }
  return "sent";
}

// ---------- Setup ----------

async function setup() {
  if (!token()) return Response.json({ ok: false, reason: "Додайте ASYSTENT_BOT_TOKEN у Supabase → Edge Functions → Secrets" }, { status: 500 });
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/asystent`;
  const hook = await tg("setWebhook", { url, secret_token: await webhookSecret(), allowed_updates: ["message", "callback_query"] });
  await tg("setMyCommands", { commands: [
    { command: "plan", description: "Усі нагадування" },
    { command: "pamyat", description: "Що я памʼятаю" },
    { command: "start", description: "Як зі мною працювати" },
  ] });
  const me = await tg("getMe", {});
  return Response.json({ ok: !!hook.ok, bot: me.result?.username ?? null, webhook: hook.description ?? null });
}

Deno.serve(async (req) => {
  try {
    if (req.method === "GET") {
      const q = new URL(req.url).searchParams;
      if (q.has("tick")) return Response.json(await tick());
      return await setup();
    }
    if (!token() || req.headers.get("x-telegram-bot-api-secret-token") !== await webhookSecret()) {
      return new Response("forbidden", { status: 403 });
    }
    const update = await req.json();
    if (update.message) await onMessage(update.message);
    else if (update.callback_query) await onCallback(update.callback_query);
  } catch (e) {
    console.error(e);
  }
  return new Response("ok");
});
