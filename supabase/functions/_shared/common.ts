// Shared by the `api` (mini-app) and `bot` (Telegram webhook) functions.
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

export const CHANNELS = [
  "Google", "Glovo", "Bolt", "Оцінки в додатку", "Підтримка в додатку",
  "Instagram", "Telegram", "Threads", "Оператори", "Сайт",
];
export const TOPICS = [
  "М'ясо", "Соус", "Овочі / капуста", "Розвалюється", "Холодний", "Сторонній предмет",
  "Забули додаток", "Довге очікування", "Персонал", "Чистота", "Доставка",
  "Додаток / бонуси", "Розмір і ціна", "Отруєння / сире м'ясо",
];
export const RESULTS = [
  "Владнано",
  "Відповіли на відгук, гість не сконтактував",
  "Гість сконтактував, у процесі",
  "Гість не сконтактував",
];
export const ROLES: Record<string, string> = {
  admin: "Адміністратор",
  comms: "Комунікаційник",
  loc_admin: "Адмін точки",
  operator: "Оператор",
};

// Channels each role may add. Missing = all channels.
const ROLE_CHANNELS: Record<string, string[]> = {
  loc_admin: ["Glovo", "Bolt"],
  operator: ["Оператори", "Сайт"],
};
export function channelsFor(role: string): string[] {
  return ROLE_CHANNELS[role] ?? CHANNELS;
}

export const APP_URL = Deno.env.get("APP_URL") ?? "https://kebabtsiaua-prog.github.io/kebabtsia-vidguky/";

export const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

export type User = {
  tg_id: number;
  name: string;
  username: string | null;
  role: string;
  location_id: number | null;
  active: boolean;
};

export type Location = { id: number; name: string; city: string; aliases: string[]; active: boolean };

function botToken(): string {
  const t = Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim();
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not set in Supabase secrets");
  return t;
}

export async function tg(method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) console.error("telegram", method, json.description);
  return json;
}

export async function tgFile(fileId: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const info = await tg("getFile", { file_id: fileId });
  const path: string = info.result.file_path;
  const res = await fetch(`https://api.telegram.org/file/bot${botToken()}/${path}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const mime = path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : "image/jpeg";
  return { bytes, mime };
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// Webhook secret derived from the bot token, so nobody has to create or paste a second secret.
export async function webhookSecret(): Promise<string> {
  return hex(await hmac(new TextEncoder().encode("kebabtsia-webhook"), botToken())).slice(0, 48);
}

// Checks Telegram Mini App initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
export async function telegramUser(initData: string): Promise<{ id: number; first_name: string; last_name?: string; username?: string } | null> {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), botToken());
  if (hex(await hmac(secret, check)) !== hash) return null;
  const age = Date.now() / 1000 - Number(params.get("auth_date") ?? 0);
  if (age > 7 * 24 * 3600) return null;
  try {
    return JSON.parse(params.get("user") ?? "null");
  } catch {
    return null;
  }
}

export async function getUser(tgId: number): Promise<User | null> {
  const { data } = await db.from("users").select("*").eq("tg_id", tgId).eq("active", true).maybeSingle();
  return data as User | null;
}

export function displayName(u: { first_name?: string; last_name?: string; username?: string }): string {
  return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "Без імені";
}

// The very first person to open the bot becomes the administrator; everybody after needs a code.
export async function bootstrapAdmin(from: { id: number; first_name?: string; last_name?: string; username?: string }): Promise<User | null> {
  const { count } = await db.from("users").select("tg_id", { count: "exact", head: true });
  if (count !== 0) return null;
  const row = { tg_id: from.id, name: displayName(from), username: from.username ?? null, role: "admin" };
  const { data, error } = await db.from("users").insert(row).select().single();
  if (error) return null;
  return data as User;
}

export async function redeemCode(code: string, from: { id: number; first_name?: string; last_name?: string; username?: string }): Promise<User | null> {
  const clean = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,10}$/.test(clean)) return null;
  const { data: inv } = await db.from("invites").select("*").eq("code", clean).is("used_by", null).maybeSingle();
  if (!inv) return null;
  const { data: claimed } = await db.from("invites")
    .update({ used_by: from.id, used_at: new Date().toISOString() })
    .eq("code", clean).is("used_by", null).select().maybeSingle();
  if (!claimed) return null;
  const row = {
    tg_id: from.id,
    name: inv.name || displayName(from),
    username: from.username ?? null,
    role: inv.role,
    location_id: inv.location_id,
    active: true,
  };
  const { data } = await db.from("users").upsert(row).select().single();
  return data as User;
}

export function newCode(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(r, (x) => abc[x % abc.length]).join("");
}

export async function activeLocations(): Promise<Location[]> {
  const { data } = await db.from("locations").select("id,name,city,aliases,active").eq("active", true).order("name");
  return (data ?? []) as Location[];
}

export function kyivToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());
}

// Keywords used when the AI is not available, so topics are still filled in.
const KW: [string, RegExp][] = [
  ["М'ясо", /м['’ʼ]?яс|телят|кур(к|ин)/i], ["Соус", /соус/i], ["Овочі / капуста", /капуст|овоч|цибул|огір|помід/i],
  ["Розвалюється", /розвал|порвав|розлі|розірв/i], ["Холодний", /холод/i], ["Сторонній предмет", /волос|плівк|кістк|пластмас/i],
  ["Забули додаток", /забули|не поклали|халапен/i], ["Довге очікування", /чекал|очікув|годин|довго/i],
  ["Персонал", /касир|персонал|неввічл|грубо/i], ["Чистота", /брудн|чисто/i], ["Доставка", /доставк|кур['’ʼ]?єр/i],
  ["Додаток / бонуси", /додатк|бонус/i], ["Розмір і ціна", /розмір|маленьк|ціна|дорого/i],
  ["Отруєння / сире м'ясо", /отру|сир[ еоа]|лікар/i],
];
export function keywordTopics(text: string): string[] {
  return KW.filter(([, re]) => re.test(text)).map(([t]) => t);
}

export async function savePhoto(complaintId: number, bytes: Uint8Array, mime: string): Promise<string | null> {
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const path = `${complaintId}.${ext}`;
  const { error } = await db.storage.from("photos").upload(path, bytes, { contentType: mime, upsert: true });
  if (error) {
    console.error("photo upload", error.message);
    return null;
  }
  await db.from("complaints").update({ photo_path: path }).eq("id", complaintId);
  return path;
}
