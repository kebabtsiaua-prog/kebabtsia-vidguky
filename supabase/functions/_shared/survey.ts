// Team survey before the cabinet opens (owner 2026-10-24): open answers only, at least MIN characters each,
// a separate set of questions per role. Роман («roman» set) answers how it SHOULD work; everyone else how it works now.
import Anthropic from "npm:@anthropic-ai/sdk@0.133.0";
import { db, type User } from "./common.ts";

export const MIN = 120;

export type Question = { t: string; q: string };
export const SETS: Record<string, { who: string; q: Question[] }> = {
  admin: { who: "Адміни точок", q: [
    { t: "Ваша робота", q: "Розкажіть про свою роботу: як давно ви адмін, за які точки відповідаєте, у які дні й години ви на кожній із них і хто вас підміняє?" },
    { t: "Звідки скарги", q: "Звідки ви дізнаєтесь про скарги на ваші точки? Перелічіть усі способи: гість на касі, Glovo, Bolt, Google, додаток, повідомлення від Ані, Олени чи керівника." },
    { t: "Glovo і Bolt", q: "Як часто і о котрій ви заходите в кабінети Glovo і Bolt? Хто ще на ваших точках має до них доступ і чи дивиться туди?" },
    { t: "Остання скарга", q: "Опишіть останню скаргу, з якою ви працювали: що сталося, що ви робили крок за кроком і чим усе скінчилось." },
    { t: "Хто закриває", q: "Які скарги ви вирішуєте самі, а які передаєте далі? Хто, на вашу думку, має закривати скарги на ваших точках і чому?" },
    { t: "Перевірка", q: "Як ви перевіряєте, чи скарга правдива: камери, чек, розмова з кухарями? Скільки часу на це йде?" },
    { t: "Записи", q: "Що з роботи над скаргами ви десь записуєте, а що лишається тільки в переписці чи в голові?" },
    { t: "Що заважає", q: "Що найбільше заважає працювати зі скаргами і що б ви змінили в першу чергу?" },
  ] },
  // Tour only, no questions (Юра, the CEO, owner 2026-10-26).
  tour: { who: "Керівник компанії", q: [] },
  oper: { who: "Операторки", q: [
    { t: "Звідки скарги", q: "Як до вас потрапляють скарги: дзвінки, сайт, чат? Скільки приблизно за тиждень і в які години найбільше?" },
    { t: "Дзвінок", q: "Опишіть, що ви робите, коли гість скаржиться по телефону, від першого слова до кінця розмови." },
    { t: "Дані гостя", q: "Які дані гостя ви записуєте (ім'я, телефон, номер замовлення, точка) і куди саме?" },
    { t: "Кому передаєте", q: "Кому і як ви передаєте скаргу: дзвінок, Telegram, таблиця? Чи дізнаєтесь потім, чим вона скінчилась?" },
    { t: "Самі вирішуєте", q: "Які скарги ви вирішуєте самі, наприклад повторна доставка чи знижка? Хто це дозволяє і де це записано?" },
    { t: "Що заважає", q: "Що найбільше заважає і що б ви змінили в роботі зі скаргами?" },
  ] },
  comm: { who: "Комунікації", q: [
    { t: "Розподіл", q: "Які канали веде кожна з вас і як ви ділите роботу: по каналах, по точках, по змінах?" },
    { t: "Як часто", q: "Як часто і о котрій ви перевіряєте кожен канал: Google, Instagram, Telegram, Threads, підтримку в додатку?" },
    { t: "Шлях скарги", q: "Опишіть шлях однієї скарги: від моменту, коли ви її побачили, до запису в таблиці. Хто ще бере участь?" },
    { t: "Адмін точки", q: "Як ви звертаєтесь до адміна точки і скільки зазвичай чекаєте відповіді? Що робите, якщо він мовчить?" },
    { t: "Компенсація", q: "Хто вирішує, чи дати гостю компенсацію, подарунок чи повторне замовлення? За якими правилами?" },
    { t: "Закрито", q: "Коли скарга для вас закрита? Що ви пишете в колонки «Рішення» і «Результат»?" },
    { t: "Що забирає час", q: "Що забирає найбільше часу і що б ви хотіли, щоб апка робила за вас?" },
  ] },
  roman: { who: "Керівник", q: [
    { t: "Що доходить до вас", q: "Які скарги мають доходити особисто до вас, а які команда закриває без вас? Що для вас «серйозна» скарга?" },
    { t: "Хто відповідає", q: "Хто має відповідати за скаргу на точці: адмін, Аня й Олена чи хтось інший? Опишіть, як має бути, а не як є зараз." },
    { t: "Терміни", q: "За який час скаргу треба взяти в роботу і за який закрити? Чи різниться це для Google, Glovo, Bolt і додатку?" },
    { t: "Компенсації", q: "Хто і коли може дати гостю компенсацію чи повторне замовлення? Які межі для адміна, операторки й комунікацій?" },
    { t: "Контроль", q: "Як ви зараз дізнаєтесь, що на точці проблема? Що хочете бачити щотижня і щомісяця?" },
    { t: "Що не влаштовує", q: "Що в теперішній роботі зі скаргами вас найбільше не влаштовує і що треба змінити першим?" },
  ] },
};

export type SurveyUser = User & {
  survey_set: string | null;
  survey_due_at: string | null;
  survey_done_at: string | null;
  tour_done_at: string | null;
  locs_confirmed_at?: string | null;
};

export function setOf(u: SurveyUser): string {
  if (u.survey_set) return u.survey_set;
  return ({ loc_admin: "admin", operator: "oper", comms: "comm", admin: "roman" } as Record<string, string>)[u.role] ?? "none";
}

// Invited and not through the survey and the tour yet: the cabinet stays closed.
export function locked(u: SurveyUser): boolean {
  return !!u.survey_due_at && setOf(u) !== "none" && !(u.survey_done_at && u.tour_done_at);
}

export function inviteText(u: SurveyUser): string {
  const set = SETS[setOf(u)];
  const n = set?.q.length ?? 0;
  const first = u.name.trim().split(/\s+/)[0];
  if (u.role === "loc_admin" && !u.locs_confirmed_at) {
    return `👋 <b>Вітаємо в апці «Відгуки»!</b>\n\nТут збираються всі скарги гостей з Glovo, Bolt, Google та інших сервісів. Натисніть «Почати»: напишіть ім'я і виберіть точки, за які відповідаєте. Далі ${n} питань про те, як ви зараз працюєте зі скаргами, близько 10 хвилин, і коротка екскурсія по апці.\n\n` +
      "Відповідайте детально, своїми словами. Якщо в апці щось незручно, напишіть тут кнопкою «Зауваження до апки».";
  }
  if (setOf(u) === "tour") {
    return `👋 <b>Вітаємо у «Відгуках», ${first}!</b>\n\nТут в одному місці всі скарги та відгуки гостей з усіх точок Кебабці: Google, Glovo, Bolt, Instagram, Telegram, додаток і оператори. Видно, що чекає рішення, хто ним займається і чим закінчилось.\n\n` +
      "Перед першим входом коротка екскурсія: 4 кроки, близько 2 хвилин. Після неї відкриється повний кабінет.\n\n" +
      "Якщо щось варто змінити, напишіть тут, у чаті з ботом, кнопкою «Зауваження до апки».";
  }
  if (setOf(u) === "roman") {
    return `👥 <b>Опитування команди</b>\n\n${first}, усе готово, можна починати. ${n} питань про те, як має працювати робота зі скаргами, близько 10 хвилин. Пишіть детально, своїми словами.\n\n` +
      "Після опитування буде коротка екскурсія по апці: як усе працює зараз. Якщо щось варто змінити, напишіть зауваження тут, у чаті з ботом, кнопкою «Зауваження до апки».";
  }
  return `👥 <b>Вас запрошено до апки «Відгуки»</b>\n\n${first}, тут збираються всі скарги гостей. Кабінет відкриється після короткого знайомства: ${n} питань про те, як ви зараз працюєте зі скаргами, близько 10 хвилин, потім коротка екскурсія по апці. Пишіть детально, своїми словами.\n\nЯкщо в апці щось незручно, напишіть тут, у чаті з ботом, кнопкою «Зауваження до апки».`;
}

// One follow-up question when an answer is long enough but still vague. Never blocks: no key or an error means no question.
export async function followUp(question: string, answer: string): Promise<string | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  if (!apiKey) return null;
  try {
    const client = new Anthropic({ apiKey });
    // deno-lint-ignore no-explicit-any
    const params: any = {
      model: "claude-opus-5-5",
      max_tokens: 1500,
      system: "Ти допомагаєш власнику мережі кебабних «Кебабця» зрозуміти, як команда працює зі скаргами гостей. " +
        "Тобі дають питання опитування і відповідь працівника. Якщо відповідь конкретна (є хто, що, як, коли), поверни порожній рядок. " +
        "Якщо відповідь розмита, загальна або не відповідає на частину питання, поверни одне коротке доброзичливе уточнювальне питання українською (до 200 символів), звертаючись на «ви».",
      messages: [{ role: "user", content: `Питання: ${question}\n\nВідповідь: ${answer}` }],
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: { type: "object", properties: { ask: { type: "string" } }, required: ["ask"], additionalProperties: false } },
      },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
    const res = await client.beta.messages.create(params);
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return null;
    const ask = String(JSON.parse(block.text).ask ?? "").trim();
    return ask.length > 5 ? ask.slice(0, 300) : null;
  } catch (e) {
    console.error("follow-up", e);
    return null;
  }
}

// Remarks about the app go through the bot: this button sits under the message field.
// The owner: the first administrator, who is never asked.
export async function ownerId(): Promise<number | null> {
  const { data } = await db.from("users").select("tg_id").eq("survey_set", "none").eq("role", "admin").order("created_at").limit(1).maybeSingle();
  return data?.tg_id ?? null;
}

export const FEEDBACK_BTN = "💬 Зауваження до апки";
export const FEEDBACK_KB = { keyboard: [[{ text: FEEDBACK_BTN }]], resize_keyboard: true, is_persistent: true };
