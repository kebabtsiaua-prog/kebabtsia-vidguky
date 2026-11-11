// The girls' review sheet (one tab per Lviv location and month, a row per day, a column per channel) sent by a
// Google Apps Script in that sheet (apps-script/girls-sheet/Code.gs). Every complaint they wrote that the app does
// not have yet is added, so the app and the sheet always match (October check 2026-11-11: ~half of the sheet was
// missing from the app). What the app already has is only linked, never added twice.
import { db, keywordTopics, kyivToday } from "./common.ts";
import { alias, findDuplicate } from "./dedupe.ts";

const MONTHS = ["січ", "лют", "берез", "квіт", "трав", "черв", "лип", "серп", "верес", "жовт", "листоп", "груд"];

// Tab nickname → a piece of the location's name in the app (mapping confirmed with the owner 2026-10-23).
const NICK: [RegExp, string][] = [
  [/крива/i, "Крива Липа"], [/упа/i, "Героїв УПА"], [/семицвіт/i, "Семицвіт"], [/форум|forum/i, "Під дубом"],
  [/сихів/i, "Червоної Калини"], [/вікторія|^вг\s|victoria/i, "Кульпарківська"], [/чорновола|ню поінт|new point/i, "Чорновола 16"],
  [/хуторівка|шувар/i, "Хуторівка"], [/ольги/i, "Княгині Ольги"], [/рясне/i, "Рясне"], [/левандівка/i, "Широка"],
  [/вокзал/i, "Вокзал"], [/валова/i, "Валова"], [/спартак|spartak/i, "Мазепи"],
];

// Column header → app channel. Other columns («Кухарі/Касири», «Робочі зняття») are staff notes, not guests.
function channelOf(h: string): string | null {
  const s = h.trim().toUpperCase();
  if (s === "GOOGLE") return "Google";
  if (s === "TELEGRAM") return "Telegram";
  if (s === "INSTAGRAM") return "Instagram";
  if (s === "GLOVO") return "Glovo";
  if (s === "BOLT") return "Bolt";
  if (s.startsWith("ОПЕРАТОР")) return "Оператори";
  if (s === "САЙТ") return "Сайт";
  if (s === "ДОДАТОК") return "Оцінки в додатку";
  if (s === "THREADS" || s === "TREADS") return "Threads";
  return null;
}

// "Валова жовтень", "Форум жовтень26", "Чорновола Жовтень 2026" → month index, or -1.
function monthOf(title: string): number {
  const t = title.toLowerCase();
  return MONTHS.findIndex((m) => t.includes(m));
}

// One cell sometimes holds two guests' reviews: "1.ЗАБАГАТО СОУСУ 2.ТРОХИ ХОЛОДНИЙ КЕБАБ".
function split(cell: string): string[] {
  const t = cell.replace(/\r/g, "").trim();
  if (!/^1\s*[.)]/.test(t) || !/\s2\s*[.)]|[^\d]2\s*[.)]/.test(t)) return t ? [t] : [];
  return t.split(/(?:^|\s|(?<=\D))\d\s*[.)]\s*/).map((x) => x.trim()).filter(Boolean);
}

async function sha(s: string) {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(b.slice(0, 5), (x) => x.toString(16).padStart(2, "0")).join("");
}

export type Tab = { title: string; values: string[][] };
export type SheetResult = { added: { id: number; loc: string; channel: string; day: string; text: string }[]; linked: number; tabs: string[]; skipped: string[] };

export async function importGirlsSheet(tabs: Tab[]): Promise<SheetResult> {
  const today = kyivToday();
  const [y, m] = today.split("-").map(Number);
  // This month and the one before: the girls finish last month's report in the first days of the next.
  const wanted = [{ y, m: m - 1 }, m === 1 ? { y: y - 1, m: 11 } : { y, m: m - 2 }];
  const { data: locs } = await db.from("locations").select("id,name");
  const res: SheetResult = { added: [], linked: 0, tabs: [], skipped: [] };
  for (const tab of tabs) {
    const mi = monthOf(tab.title);
    const when = wanted.find((w) => w.m === mi);
    const loc = NICK.find(([re]) => re.test(tab.title))?.[1];
    const l = loc ? (locs ?? []).find((x) => x.name.includes(loc)) : null;
    if (!when || !l) continue;
    // A tab without a year belongs to the latest such month (titles like «валова жовтень»).
    const yr = tab.title.match(/20\d\d|\b\d\d\b/)?.[0];
    if (yr && Number(yr.length === 2 ? "20" + yr : yr) !== when.y) continue;
    res.tabs.push(tab.title);
    const head = tab.values[0] ?? [];
    for (const row of tab.values.slice(1)) {
      const d = parseInt(String(row[0] ?? ""), 10);
      if (!(d >= 1 && d <= 31)) continue;
      const day = `${when.y}-${String(when.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (day > today || Number(day.slice(8)) !== new Date(Date.parse(day)).getUTCDate()) continue;
      for (let c = 1; c < row.length; c++) {
        const channel = channelOf(String(head[c] ?? ""));
        if (!channel) continue;
        for (const text of split(String(row[c] ?? ""))) {
          if (text.replace(/[^\p{L}]/gu, "").length < 3) { res.skipped.push(`${tab.title} ${d}: ${text}`); continue; }
          const ext = `sheet:${day.slice(0, 7)}:${await sha(`${l.id}|${channel}|${day}|${text}`)}`;
          // The girls sometimes write app reviews into the TELEGRAM column, so the channel is not compared here.
          const dup = await findDuplicate({ location_id: l.id, channel, happened_on: day, text, external_id: ext }, true);
          if (dup) {
            await alias(ext, dup);
            res.linked++;
            continue;
        }
        const { data: made } = await db.from("complaints").insert({
          location_id: l.id, channel, happened_on: day, text, topics: keywordTopics(text), source: "sheet", external_id: ext,
        }).select("id").maybeSingle();
        if (made) res.added.push({ id: made.id, loc: l.name, channel, day, text });
        }
      }
    }
  }
  return res;
}
