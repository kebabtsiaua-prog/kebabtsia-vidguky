// Bolt reviews: Bolt Merchant shows them only as a table on its site, so the Chrome extension reads the table
// on the logged-in page and sends the rows here (2026-10-30). Only negative reviews become complaints, as for Glovo.
import { negativeReviews } from "./ai.ts";
import { activeLocations, db, hasComment } from "./common.ts";
import { alertTake } from "./glovo.ts";

export type BoltRow = { id: string; rating: number | null; at: string; tags: string[]; text: string };
export type BoltResult = { store: string; known: boolean; rows: number; fresh: number; withText: number; complaints: { id: number; loc: string }[] };

// The first read of a store brings the page's whole month; older reviews are only stored, so nobody gets alerts about
// October 1st. After that a review up to two weeks old still becomes a complaint, so a few days without the page open
// lose nothing (audit 2026-11-01).
const FIRST_DAYS = 2, LATER_DAYS = 14;

// «29.10.2026 18:14» on the page is Kyiv time.
export function kyivTime(s: string): string | null {
  const m = s.match(/(\d\d)\.(\d\d)\.(\d{4})\s+(\d\d):(\d\d)/);
  if (!m) return null;
  const guess = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00Z`);
  const off = new Date(guess.toLocaleString("en-US", { timeZone: "Europe/Kyiv" })).getTime() - new Date(guess.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  return new Date(guess.getTime() - off).toISOString();
}

export async function importBolt(store: string, rows: BoltRow[]): Promise<BoltResult> {
  const name = store.replace(/\s+/g, " ").trim();
  const { data: mapped } = await db.from("locations").select("id,bolt_stores").not("bolt_stores", "is", null);
  const locId = (mapped ?? []).find((l) => (l.bolt_stores ?? []).includes(name))?.id ?? null;
  const loc = locId ? (await activeLocations()).find((l) => l.id === locId) : undefined;
  const res: BoltResult = { store: name, known: !!loc, rows: rows.length, fresh: 0, withText: 0, complaints: [] };
  const texts: { key: string; at: string; body: string; rating: number | null }[] = [];
  const { count: seen } = await db.from("bolt_reviews").select("id", { count: "exact", head: true }).eq("store", name).not("location_id", "is", null);
  const window = (seen ? LATER_DAYS : FIRST_DAYS) * 86400000;
  // Rows kept while the store was unknown: now that it is tied to a location, they get it and are read again.
  if (loc) {
    const { data: orphans } = await db.from("bolt_reviews").select("id,rated_at,text,rating").eq("store", name).is("location_id", null);
    for (const o of orphans ?? []) {
      await db.from("bolt_reviews").update({ location_id: loc.id }).eq("id", o.id);
      if (hasComment(o.text ?? "") && Date.now() - Date.parse(o.rated_at) < LATER_DAYS * 86400000) {
        texts.push({ key: o.id, at: o.rated_at, body: o.text.trim(), rating: o.rating });
      }
    }
  }
  for (const r of rows) {
    const at = kyivTime(r.at);
    if (!r.id || !at) continue;
    const key = `${name}:${r.id}`;
    const body = (r.text ?? "").trim();
    const { data: ins } = await db.from("bolt_reviews").upsert({
      id: key, store: name, location_id: loc?.id ?? null, rated_at: at,
      rating: Number.isInteger(r.rating) ? r.rating : null, tags: r.tags ?? [], text: body,
    }, { onConflict: "id", ignoreDuplicates: true }).select("id");
    if (!ins?.length) continue;
    res.fresh++;
    if (hasComment(body) && Date.now() - Date.parse(at) < window) texts.push({ key, at, body, rating: Number.isInteger(r.rating) ? r.rating : null });
  }
  res.withText = texts.length;
  if (!loc) return res;
  const verdicts = await negativeReviews(texts.map((x) => x.body));
  for (const [i, x] of texts.entries()) {
    if (!verdicts[i].negative) continue;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date(x.at));
    const { data: c } = await db.from("complaints").insert({
      location_id: loc.id, channel: "Bolt", happened_on: day, text: x.body, rating: x.rating, topics: verdicts[i].topics,
      source: "bolt", external_id: `bolt:${x.key}`,
    }).select("id").single();
    if (!c) continue;
    await db.from("bolt_reviews").update({ complaint_id: c.id }).eq("id", x.key);
    res.complaints.push({ id: c.id, loc: loc.name });
    await alertTake(c.id);
  }
  return res;
}
