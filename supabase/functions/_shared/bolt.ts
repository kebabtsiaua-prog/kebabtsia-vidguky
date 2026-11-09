// Bolt reviews: Bolt Merchant shows them only as a table on its site, so the Chrome extension reads the table
// on the logged-in page and sends the rows here (2026-10-30). Only negative reviews become complaints, as for Glovo.
import * as XLSX from "npm:xlsx@0.18.5";
import { negativeReviews } from "./ai.ts";
import { activeLocations, db, hasComment } from "./common.ts";
import { alertTake } from "./glovo.ts";

export type BoltRow = { id: string; rating: number | null; at: string; tags: string[]; text: string };
export type BoltResult = { store: string; known: boolean; rows: number; fresh: number; withText: number; complaints: { id: number; loc: string }[] };

// The first read brings the page's whole month; older reviews are only stored, so nobody gets alerts about October 1st.
const FRESH_DAYS = 2;

// «29.10.2026 18:14» on the page is Kyiv time.
export function kyivTime(s: string): string | null {
  const m = s.match(/(\d\d)\.(\d\d)\.(\d{4})\s+(\d\d):(\d\d)/);
  if (!m) return null;
  const guess = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00Z`);
  const off = new Date(guess.toLocaleString("en-US", { timeZone: "Europe/Kyiv" })).getTime() - new Date(guess.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  return new Date(guess.getTime() - off).toISOString();
}

// Bolt's daily email «Ratings_and_Comments_<date>.xlsx» (from 2026-11-09): every order of the previous day in
// every store, with the guest's rating and comment when there is one. A store is «<City> · <Provider Name>»
// (plain «Кебабця» in one-store cities), mapped in locations.bolt_stores. Rows without rating or comment are skipped.
export function parseBoltReport(bytes: Uint8Array): Map<string, BoltRow[]> | null {
  let rows: unknown[][];
  try {
    const wb = XLSX.read(bytes, { type: "array", cellDates: true });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null }) as unknown[][];
  } catch { return null; }
  const head = (rows[0] ?? []).map((h) => String(h ?? ""));
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const c = { city: col(/City Name/i), store: col(/Provider Name/i), rating: col(/Rating Value/i), text: col(/Rating History Comment/i), order: col(/Order Order ID|Order ID$/i), at: col(/Order Created/i) };
  if (Object.values(c).some((i) => i < 0)) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const out = new Map<string, BoltRow[]>();
  for (const r of rows.slice(1)) {
    const rating = Number(r[c.rating]);
    const text = String(r[c.text] ?? "").trim();
    if (!(rating >= 1) && !text) continue;
    const d = r[c.at];
    // The report's times are Kyiv wall-clock; SheetJS hands them over as if they were UTC.
    const at = d instanceof Date ? `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
      : String(d ?? "").replace(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d).*/, "$3.$2.$1 $4:$5");
    const store = `${String(r[c.city] ?? "").trim()} · ${String(r[c.store] ?? "").trim()}`;
    if (!out.has(store)) out.set(store, []);
    out.get(store)!.push({ id: `order-${r[c.order]}`, rating: rating >= 1 ? rating : null, at, tags: [], text });
  }
  return out;
}

export async function importBolt(store: string, rows: BoltRow[]): Promise<BoltResult> {
  const name = store.replace(/\s+/g, " ").trim();
  const { data: mapped } = await db.from("locations").select("id,bolt_stores").not("bolt_stores", "is", null);
  const locId = (mapped ?? []).find((l) => (l.bolt_stores ?? []).includes(name))?.id ?? null;
  const loc = locId ? (await activeLocations()).find((l) => l.id === locId) : undefined;
  const res: BoltResult = { store: name, known: !!loc, rows: rows.length, fresh: 0, withText: 0, complaints: [] };
  const texts: { key: string; at: string; body: string; rating: number | null }[] = [];
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
    if (hasComment(body) && Date.now() - Date.parse(at) < FRESH_DAYS * 86400000) texts.push({ key, at, body, rating: Number.isInteger(r.rating) ? r.rating : null });
  }
  res.withText = texts.length;
  if (!loc) return res;
  const verdicts = await negativeReviews(texts.map((x) => x.body));
  for (const [i, x] of texts.entries()) {
    if (!verdicts[i].negative) continue;
    // The extension may already have added the same review from the Bolt Merchant page.
    const { data: same } = await db.from("complaints").select("id").eq("channel", "Bolt").eq("location_id", loc.id).eq("text", x.body)
      .gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString()).limit(1);
    if (same?.length) { await db.from("bolt_reviews").update({ complaint_id: same[0].id }).eq("id", x.key); continue; }
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
