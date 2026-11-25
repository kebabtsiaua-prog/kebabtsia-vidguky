// A low Google review becomes a complaint and a direct message to the team. Used by the Places check (`google`)
// and by the full Business Profile sync (`gbp`).
import { db, itemUrl, sign, tg } from "./common.ts";
import { NEGATIVE_MAX, recipients } from "./uployal.ts";
import { alias, findDuplicate } from "./dedupe.ts";

export const escH = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const DAY = 86400000;
export const COMPLAINT_WINDOW = 14 * DAY;

export type ReviewIn = { ext: string; rating: number | null; text: string; author: string; at: Date | null };

// Complaint id when a new one was made; null for a good, old or already known review.
// `silent`: the full Google sync sends its own card for every review (greviews.ts), so no separate message.
export async function googleComplaint(l: { id: number; name: string }, r: ReviewIn, silent = false): Promise<number | null> {
  if (!r.rating || r.rating > NEGATIVE_MAX || !r.at || Date.now() - r.at.getTime() > COMPLAINT_WINDOW) return null;
  const day = r.at.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const dup = await findDuplicate({ location_id: l.id, channel: "Google", happened_on: day, text: r.text, external_id: r.ext });
  if (dup) {
    await alias(r.ext, dup);
    await db.from("complaints").update({ rating: r.rating }).eq("id", dup).is("rating", null);
    return null;
  }
  const { data: c } = await db.from("complaints").insert({
    location_id: l.id, channel: "Google", happened_on: day, rating: r.rating,
    text: r.text || `Оцінка ${r.rating} без коментаря`, source: "google", external_id: r.ext,
  }).select("id").maybeSingle();
  if (!c) return null;
  if (silent) return c.id;
  const msg = [
    `🔴 <b>Відгук ${r.rating} з 5 у Google</b>`,
    `${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)} · ${day.split("-").reverse().join(".")}`,
    "",
    `<b>Точка:</b> ${escH(l.name)}`,
  ];
  if (r.author) msg.push(`<b>Гість:</b> ${escH(r.author)}`);
  msg.push(r.text ? `<blockquote>${escH(r.text)}</blockquote>` : "<i>Без тексту, лише оцінка.</i>", "<i>Дайте відповідь на відгук у Google і запишіть рішення в апці.</i>");
  for (const u of await recipients()) {
    await tg("sendMessage", {
      chat_id: u.tg_id, parse_mode: "HTML", text: msg.join("\n"),
      reply_markup: { inline_keyboard: [[{ text: "Відкрити скаргу", web_app: { url: itemUrl(c.id) } }]] },
    }).catch(console.error);
  }
  return c.id;
}

// The link the bot gives an admin for /google: opens Google's consent screen through the `gbp` function.
// State «<tg_id>.<expires>.<signature>», valid for 30 minutes, so nobody else can connect their own Google account.
export async function connectLink(tgId: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 1800;
  const state = `${tgId}.${exp}.${await sign("google", `${tgId}.${exp}`)}`;
  return `${Deno.env.get("SUPABASE_URL")}/functions/v1/gbp?connect=${state}`;
}
