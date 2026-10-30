// Reads a complaint (text and/or screenshot) and fills location, channel, text, date and topics.
import Anthropic from "npm:@anthropic-ai/sdk@0.133.0";
import { CHANNELS, keywordTopics, kyivToday, type Location, TOPICS } from "./common.ts";

export type Parsed = {
  location_id: number | null;
  channel: string | null;
  text: string;
  date: string | null; // YYYY-MM-DD
  topics: string[];
  rating: number | null;
};

const SCHEMA = {
  type: "object",
  properties: {
    location: { type: "string", description: "Exact name from the list of locations, or empty string if unclear" },
    channel: { type: "string", enum: [...CHANNELS, ""] },
    text: { type: "string", description: "The guest's complaint in Ukrainian, as close to the original as possible" },
    date: { type: "string", description: "Date of the review YYYY-MM-DD if visible, else empty string" },
    topics: { type: "array", items: { type: "string", enum: TOPICS } },
    rating: { type: "integer", description: "Stars 1-5 if visible, else 0" },
  },
  required: ["location", "channel", "text", "date", "topics", "rating"],
  additionalProperties: false,
};

function system(locations: Location[]): string {
  const locs = locations.map((l) => `- ${l.name}${l.aliases.length ? ` (також: ${l.aliases.join(", ")})` : ""}`).join("\n");
  return `Ти допомагаєш мережі кебабних «Кебабця» вносити скарги гостей.
Тобі надсилають скриншот або текст відгуку зі сторонніх сервісів (Google, Glovo, Bolt, Instagram, Telegram, Threads, програма лояльності Uployal, підтримка в додатку, оператори, сайт).
Визнач, до якої точки відноситься відгук, з якого каналу він, і перепиши суть скарги українською, без імен і телефонів гостя.
Якщо точку чи канал не можна визначити впевнено, поверни порожній рядок. Не вигадуй.
Сьогодні ${kyivToday()}.

Точки:
${locs}

Канали: ${CHANNELS.join(", ")}.
Підказки щодо каналу: повідомлення Uployal з «Оцінка замовлення» = «Оцінки в додатку»; інтерфейс Glovo жовто-зелений; Bolt зелений; Google Maps показує зірки і «Local Guide».`;
}

// The location named in the text itself, when exactly one location fits («доставка на валову» → Валова 13).
// A stem is a word of the name or a nickname without its ending (at most 6 letters); stems that are also everyday
// words are skipped, and a word that fits several locations (Шевченка, Львів) decides nothing.
// The text wins over the AI: it once filed «доставка на валову» under Буковель.
const COMMON = new Set(["широк", "червон", "пустом", "дубо", "сотн", "іван", "бульва", "вулиц", "площ"]);
export function locationInText(locations: Location[], text: string): number | null {
  const t = text.toLowerCase().replace(/[’ʼ']/g, "");
  const fits = locations.filter((l) => {
    const words = [l.name, ...l.aliases].join(" ").toLowerCase().replace(/[’ʼ']/g, "").match(/[a-zа-яіїєґ]{5,}/g) ?? [];
    return words.map((w) => w.slice(0, Math.min(w.length - 1, 6))).some((st) =>
      !COMMON.has(st) && new RegExp(`(^|[^a-zа-яіїєґ])${st}`).test(t)
    );
  });
  return fits.length === 1 ? fits[0].id : null;
}

// Text without a screenshot names its channel in words, or the channel stays for the person to pick.
const CHANNEL_WORDS: [string, RegExp][] = [
  ["Google", /google|гугл/i], ["Glovo", /glovo|глово/i], ["Bolt", /bolt|болт/i], ["Instagram", /insta|інст/i],
  ["Telegram", /telegram|телеграм|(^|[^а-яіїєґa-z])тг([^а-яіїєґa-z]|$)/i], ["Threads", /threads|тредс/i], ["Оператори", /оператор|дзвон|дзвін/i],
  ["Сайт", /сайт/i], ["Оцінки в додатку", /оцінк|uployal/i], ["Підтримка в додатку", /підтримк|додат/i],
];
function channelNamed(text: string, channel: string | null): boolean {
  return !!channel && (CHANNEL_WORDS.find(([c]) => c === channel)?.[1].test(text) ?? false);
}

export async function parseComplaint(
  locations: Location[],
  input: { text?: string; image?: { data: string; mime: string } },
): Promise<Parsed> {
  const fallback: Parsed = {
    location_id: locationInText(locations, input.text ?? ""),
    channel: null,
    text: input.text?.trim() ?? "",
    date: null,
    topics: keywordTopics(input.text ?? ""),
    rating: null,
  };
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  if (!apiKey) return fallback;

  const content: Anthropic.ContentBlockParam[] = [];
  if (input.image) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: input.image.mime as "image/jpeg", data: input.image.data },
    });
  }
  content.push({ type: "text", text: input.text?.trim() ? `Текст від менеджера:\n${input.text}` : "Розбери скриншот." });

  try {
    const client = new Anthropic({ apiKey });
    // deno-lint-ignore no-explicit-any
    const params: any = {
      model: "claude-opus-5-5",
      max_tokens: 4000,
      system: system(locations),
      messages: [{ role: "user", content }],
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
    const res = await client.beta.messages.create(params);
    if (res.stop_reason === "refusal") return fallback;
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return fallback;
    const out = JSON.parse(block.text);
    const loc = locations.find((l) => l.name === out.location);
    const channel = CHANNELS.includes(out.channel) ? out.channel : null;
    return {
      location_id: locationInText(locations, input.text ?? "") ?? loc?.id ?? null,
      channel: input.image || channelNamed(input.text ?? "", channel) ? channel : null,
      text: String(out.text || fallback.text).trim(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(out.date ?? "") && out.date <= kyivToday() ? out.date : null,
      topics: (out.topics ?? []).filter((t: string) => TOPICS.includes(t)),
      rating: Number.isInteger(out.rating) && out.rating >= 1 && out.rating <= 5 ? out.rating : null,
    };
  } catch (e) {
    if (e instanceof Anthropic.APIError) console.error("anthropic", e.status, e.message);
    else console.error("parse", e);
    return fallback;
  }
}

// Glovo report rows carry no usable stars, so the text decides: only negative reviews become complaints (owner 2026-10-30).
// Bolt reviews go the same way.
// One request for the whole file. Without AI every review with text counts as negative, so none is lost.
export async function negativeReviews(texts: string[]): Promise<{ negative: boolean; topics: string[] }[]> {
  const fallback = texts.map((t) => ({ negative: true, topics: keywordTopics(t) }));
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  if (!apiKey || !texts.length) return fallback;
  const schema = {
    type: "object",
    properties: {
      reviews: {
        type: "array",
        items: {
          type: "object",
          properties: {
            n: { type: "integer" },
            negative: { type: "boolean", description: "true if the guest complains about anything, even politely or alongside praise" },
            topics: { type: "array", items: { type: "string", enum: TOPICS } },
          },
          required: ["n", "negative", "topics"],
          additionalProperties: false,
        },
      },
    },
    required: ["reviews"],
    additionalProperties: false,
  };
  try {
    const client = new Anthropic({ apiKey });
    // deno-lint-ignore no-explicit-any
    const params: any = {
      model: "claude-opus-5-5",
      max_tokens: 8000,
      system: "Ти читаєш відгуки гостей мережі кебабних «Кебабця» з доставки (Glovo, Bolt). Для кожного відгуку визнач, чи гість на щось скаржиться (negative), і теми скарги зі списку.",
      messages: [{ role: "user", content: texts.map((t, i) => `${i + 1}. ${t}`).join("\n") }],
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
    const res = await client.beta.messages.create(params);
    const block = res.content.find((b) => b.type === "text");
    if (res.stop_reason === "refusal" || !block || block.type !== "text") return fallback;
    const out: { n: number; negative: boolean; topics: string[] }[] = JSON.parse(block.text).reviews ?? [];
    return texts.map((t, i) => {
      const x = out.find((r) => r.n === i + 1);
      return x ? { negative: x.negative, topics: x.topics.filter((k) => TOPICS.includes(k)) } : fallback[i];
    });
  } catch (e) {
    console.error("glovo ai", e);
    return fallback;
  }
}

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
