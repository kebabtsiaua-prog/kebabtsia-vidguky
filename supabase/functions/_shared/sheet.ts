// Mirror of remarks and survey answers into a Google Sheet the owner owns, so they can be read outside the app
// (owner 2026-10-24). Secrets: GOOGLE_SERVICE_ACCOUNT (the service account's JSON key) and GOOGLE_SHEET (the sheet's
// link or id, shared with the service account as editor). Each sync rewrites both tabs from the database.
import { db, ROLES } from "./common.ts";
import { SETS, setOf, type SurveyUser } from "./survey.ts";

const TABS = { feedback: "Зауваження", answers: "Відповіді опитування" };

function sheetId(): string | null {
  const v = Deno.env.get("GOOGLE_SHEET")?.trim();
  if (!v) return null;
  return v.match(/\/d\/([\w-]+)/)?.[1] ?? v;
}

function account(): { client_email: string; private_key: string } | null {
  try {
    const a = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT") ?? "");
    return a.client_email && a.private_key ? a : null;
  } catch {
    return null;
  }
}

const b64url = (b: Uint8Array | string) =>
  btoa(typeof b === "string" ? unescape(encodeURIComponent(b)) : String.fromCharCode(...b)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function token(a: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: a.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const der = Uint8Array.from(atob(a.private_key.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claim}`)));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${b64url(sig)}` }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Google token: ${j.error ?? r.status}`);
  return j.access_token;
}

const kyiv = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", dateStyle: "short", timeStyle: "short" });

async function rows() {
  const { data: fb } = await db.from("app_feedback").select("*").order("created_at");
  const { data: ans } = await db.from("survey_answers").select("tg_id,q,answer,asked,updated_at").order("tg_id").order("q");
  const { data: users } = await db.from("users").select("*");
  const byId = new Map((users ?? []).map((u) => [u.tg_id, u as SurveyUser]));
  const role = (id: number) => ROLES[byId.get(id)?.role ?? ""] ?? "";
  const feedback = [["Коли", "Хто", "Роль", "Зауваження"], ...(fb ?? []).map((f) => [kyiv(f.created_at), f.name, role(f.tg_id), f.text])];
  const answers = [["Хто", "Роль", "Опитування пройдено", "№", "Тема", "Питання", "Відповідь", "Уточнення від ШІ", "Оновлено"],
    ...(ans ?? []).map((a) => {
      const u = byId.get(a.tg_id), q = SETS[u ? setOf(u) : ""]?.q[a.q];
      return [u?.name ?? String(a.tg_id), role(a.tg_id), u?.survey_done_at ? kyiv(u.survey_done_at) : "ще ні", a.q + 1, q?.t ?? "", q?.q ?? "", a.answer, a.asked ?? "", kyiv(a.updated_at)];
    })];
  return { feedback, answers };
}

export async function syncSheet(): Promise<Record<string, unknown>> {
  const id = sheetId(), a = account();
  if (!id || !a) return { ok: false, reason: !a ? "no GOOGLE_SERVICE_ACCOUNT" : "no GOOGLE_SHEET" };
  try {
    const t = await token(a);
    const api = (path: string, body?: unknown) =>
      fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}${path}`, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }).then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(`Sheets ${r.status}: ${j.error?.status ?? ""}`);
        return j;
      });
    const meta = await api("?fields=sheets.properties.title");
    const have = new Set((meta.sheets ?? []).map((s: { properties: { title: string } }) => s.properties.title));
    const add = Object.values(TABS).filter((n) => !have.has(n)).map((title) => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }));
    if (add.length) await api(":batchUpdate", { requests: add });
    const { feedback, answers } = await rows();
    await api("/values:batchClear", { ranges: Object.values(TABS).map((n) => `'${n}'`) });
    await api("/values:batchUpdate", {
      valueInputOption: "RAW",
      data: [{ range: `'${TABS.feedback}'!A1`, values: feedback }, { range: `'${TABS.answers}'!A1`, values: answers }],
    });
    return { ok: true, feedback: feedback.length - 1, answers: answers.length - 1 };
  } catch (e) {
    // The service account's address is what the owner shares the sheet with, so it is part of the reply.
    return { ok: false, reason: String((e as Error).message), share_with: a.client_email };
  }
}
