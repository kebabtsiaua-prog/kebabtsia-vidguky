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

export async function parseComplaint(
  locations: Location[],
  input: { text?: string; image?: { data: string; mime: string } },
): Promise<Parsed> {
  const fallback: Parsed = {
    location_id: null,
    channel: null,
    text: input.text?.trim() ?? "",
    date: null,
    topics: keywordTopics(input.text ?? ""),
    rating: null,
  };
  if (!Deno.env.get("ANTHROPIC_API_KEY")) return fallback;

  const content: Anthropic.ContentBlockParam[] = [];
  if (input.image) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: input.image.mime as "image/jpeg", data: input.image.data },
    });
  }
  content.push({ type: "text", text: input.text?.trim() ? `Текст від менеджера:\n${input.text}` : "Розбери скриншот." });

  try {
    const client = new Anthropic();
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
    return {
      location_id: loc?.id ?? null,
      channel: CHANNELS.includes(out.channel) ? out.channel : null,
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

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
