// Keeps one complaint per guest problem (October check 2026-11-11: the same review got in twice — once from Google,
// once by hand; once from the sheet, once by hand). Every place that creates a complaint asks here first.
import { db } from "./common.ts";

const DAY = 86400000;
const shift = (day: string, n: number) => new Date(Date.parse(day) + n * DAY).toISOString().slice(0, 10);

// Words of 3+ letters cut to their first 4 letters, so "холодний"/"холодним" or "курка"/"курки" count as one word.
export function words(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[ʼ'’`]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((w) => w.length > 2).map((w) => w.slice(0, 4)));
}

// Same problem told twice: most words of the shorter text are in the longer one. Across different channels the
// texts must be longer and closer, so two short "не поклали соус" from different guests are not merged.
export function similar(a: string, b: string, sameChannel: boolean): boolean {
  const A = words(a), B = words(b);
  const small = Math.min(A.size, B.size);
  if (!small) return false;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  if (sameChannel) return n >= 2 && n / small >= 0.6 || (small === 1 && n === 1 && A.size === B.size);
  return small >= 6 && n / small >= 0.75;
}

export type NewComplaint = { location_id: number; channel: string; happened_on: string; text: string; external_id?: string | null };

// Id of a complaint this one repeats: same external id (or one merged before), or same location within 3 days and
// a similar text — also the text of a copy merged away before, so a deleted duplicate never comes back.
// `anyChannel`: compare as if the channel were the same (the girls' sheet labels channels loosely). Null when new.
export async function findDuplicate(c: NewComplaint, anyChannel = false): Promise<number | null> {
  if (c.external_id) {
    const { data: al } = await db.from("complaint_aliases").select("complaint_id").eq("external_id", c.external_id).maybeSingle();
    if (al) return al.complaint_id;
    const { data: same } = await db.from("complaints").select("id").eq("external_id", c.external_id).maybeSingle();
    if (same) return same.id;
  }
  const { data } = await db.from("complaints").select("id,channel,text")
    .eq("location_id", c.location_id).gte("happened_on", shift(c.happened_on, -3)).lte("happened_on", shift(c.happened_on, 3));
  const hit = (data ?? []).find((x) => similar(x.text ?? "", c.text, anyChannel || x.channel === c.channel));
  if (hit) return hit.id;
  const { data: gone } = await db.from("complaint_aliases").select("complaint_id,channel,text")
    .eq("location_id", c.location_id).gte("happened_on", shift(c.happened_on, -3)).lte("happened_on", shift(c.happened_on, 3));
  return (gone ?? []).find((x) => x.text && similar(x.text, c.text, anyChannel || x.channel === c.channel))?.complaint_id ?? null;
}

// Remembers that `external_id` is already covered by complaint `id`, so the importer that owns it skips it next time.
export async function alias(external_id: string | null | undefined, id: number) {
  if (external_id) await db.from("complaint_aliases").upsert({ external_id, complaint_id: id }, { onConflict: "external_id" });
}

// A Google review typed in by hand: find it among the reviews the bot has read, to take its real date, stars and id
// (a hand-made copy of the 31.10 Chernivtsi review was dated the day it was typed, 02.11).
export async function googleMatch(location_id: number, text: string, near: string) {
  const { data } = await db.from("google_reviews").select("id,rating,text,published_at")
    .eq("location_id", location_id).gte("published_at", shift(near, -45)).lte("published_at", shift(near, 2) + "T23:59:59Z");
  const r = (data ?? []).find((g) => g.text && similar(g.text, text, true));
  if (!r) return null;
  const day = r.published_at ? new Date(r.published_at).toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }) : null;
  return { external_id: `google:${r.id}`, rating: r.rating as number | null, happened_on: day };
}
