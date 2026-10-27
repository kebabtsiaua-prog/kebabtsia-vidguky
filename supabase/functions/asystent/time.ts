// Kyiv time and repeat rules for reminders («29.10.2026 18:00», «щодня 10:00», «щопонеділка 10:00», «1-го числа 9:00»).

export type Parts = { y: number; m: number; d: number; h: number; mi: number };
export function kyiv(date: Date): Parts & { wd: number } {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const y = +p.year, m = +p.month, d = +p.day;
  return { y, m, d, h: +p.hour, mi: +p.minute, wd: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}
// The moment when Kyiv clocks show this date and time (summer and winter time both).
export function fromKyiv(y: number, m: number, d: number, h: number, mi: number): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = kyiv(new Date(guess));
  return new Date(guess - (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - guess));
}
export const two = (n: number) => String(n).padStart(2, "0");
export function fmt(date: Date): string {
  const p = kyiv(date);
  return `${two(p.d)}.${two(p.m)} ${two(p.h)}:${two(p.mi)}`;
}
export const DAYS = ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"];
export const kyivDay = (date: Date) => {
  const p = kyiv(date);
  return `${p.y}-${two(p.m)}-${two(p.d)}`;
};


const WEEKDAYS: [RegExp, number][] = [
  [/^понеділ/, 1], [/^вівтор/, 2], [/^серед/, 3], [/^четвер/, 4], [/^п.?ятниц/, 5], [/^субот/, 6], [/^неділ/, 0],
];
export type Rule = { kind: "day" | "week" | "month"; n: number; h: number; mi: number };
export function parseRepeat(s: string): Rule | null {
  const t = s.trim().toLowerCase().replace(/[’ʼ']/g, "");
  let m = t.match(/^щодня\s+(\d{1,2}):(\d{2})$/);
  if (m) return { kind: "day", n: 0, h: +m[1], mi: +m[2] };
  m = t.match(/^що(\S+)\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const wd = WEEKDAYS.find(([re]) => re.test(m![1]));
    if (wd) return { kind: "week", n: wd[1], h: +m[2], mi: +m[3] };
  }
  m = t.match(/^(\d{1,2})-?го\s+числа\s+(\d{1,2}):(\d{2})$/);
  if (m && +m[1] >= 1 && +m[1] <= 28) return { kind: "month", n: +m[1], h: +m[2], mi: +m[3] };
  return null;
}
// The first time the rule fires after `after`.
export function nextTime(rule: Rule, after: Date): Date | null {
  const start = kyiv(after);
  for (let i = 0; i <= 62; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const [y, m, d, wd] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), day.getUTCDay()];
    const fits = rule.kind === "day" || (rule.kind === "week" && wd === rule.n) || (rule.kind === "month" && d === rule.n);
    if (!fits) continue;
    const at = fromKyiv(y, m, d, rule.h, rule.mi);
    if (at > after) return at;
  }
  return null;
}
// «29.10.2026 18:00» once, or a repeat rule. Null when the words are not understood.
export function parseWhen(s: string): { due: Date; repeat: string | null } | null {
  const m = s.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (m) return { due: fromKyiv(+m[3], +m[2], +m[1], +m[4], +m[5]), repeat: null };
  const rule = parseRepeat(s);
  const due = rule && nextTime(rule, new Date());
  return due ? { due, repeat: s.trim() } : null;
}
