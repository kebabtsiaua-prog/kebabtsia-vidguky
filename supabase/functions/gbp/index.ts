// Google Business Profile: every review of every location, and replies to them (Basic API Access approved 2026-11-25).
//
// Connecting (once): an admin sends /google to the bot and gets a signed link → ?connect=<state> sends them to Google's
// consent screen → Google comes back here with ?code → the refresh token goes to the google_auth table (never to chat),
// each location is matched to its Business Profile by Place id, and the admin gets the result in Telegram.
// Needs GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in Supabase secrets; redirect URI = this function's URL.
//
// ?sync=1 (pg_cron, every 10 minutes): reads new and changed reviews of every matched location. A review the Places
// check already saved is recognised by author and time, so nothing is counted or reported twice.
import { db, kyivToday, sign, tg } from "../_shared/common.ts";
import { googleComplaint } from "../_shared/googlerev.ts";

const SELF = `${Deno.env.get("SUPABASE_URL")}/functions/v1/gbp`;
const SCOPE = "https://www.googleapis.com/auth/business.manage";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const DAY = 86400000;

function client() {
  const id = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")?.trim(), secret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")?.trim();
  return id && secret ? { id, secret } : null;
}

// The state in a connect link the bot gave an admin (googlerev.ts connectLink), valid for 30 minutes.
async function checkState(state: string | null): Promise<number | null> {
  const [id, exp, sig] = (state ?? "").split(".");
  if (!id || !exp || !sig || Number(exp) * 1000 < Date.now()) return null;
  if (sig !== await sign("google", `${id}.${exp}`)) return null;
  const { data: u } = await db.from("users").select("tg_id").eq("tg_id", Number(id)).eq("role", "admin").eq("active", true).maybeSingle();
  return u ? Number(id) : null;
}

async function google(url: string, token: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google ${res.status}: ${data?.error?.message ?? res.statusText}`);
  return data;
}

async function tokenCall(body: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google вхід: ${data.error_description ?? data.error ?? res.status}`);
  return data as { access_token: string; refresh_token?: string };
}

// A fresh access token from the stored refresh token; null when Google is not connected.
async function accessToken(): Promise<string | null> {
  const c = client();
  const { data: auth } = await db.from("google_auth").select("refresh_token").maybeSingle();
  if (!c || !auth) return null;
  return (await tokenCall({ client_id: c.id, client_secret: c.secret, refresh_token: auth.refresh_token, grant_type: "refresh_token" })).access_token;
}

// Matches our locations to the Business Profiles this Google account manages, by the Place id the Places check found.
async function matchLocations(token: string) {
  const { accounts = [] } = await google("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", token);
  const profiles: { gbp: string; title: string; placeId?: string }[] = [];
  for (const a of accounts) {
    let page = "";
    do {
      const d = await google(`https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title,metadata&pageSize=100${page ? `&pageToken=${page}` : ""}`, token);
      for (const l of d.locations ?? []) profiles.push({ gbp: `${a.name}/${l.name}`, title: l.title, placeId: l.metadata?.placeId });
      page = d.nextPageToken ?? "";
    } while (page);
  }
  const { data: locs } = await db.from("locations").select("id,name,google_place_id").eq("active", true).order("name");
  const matched: string[] = [], missing: string[] = [];
  for (const l of locs ?? []) {
    const p = profiles.find((x) => x.placeId && x.placeId === l.google_place_id);
    if (p) {
      await db.from("locations").update({ gbp_name: p.gbp }).eq("id", l.id);
      matched.push(l.name);
    } else missing.push(l.name);
  }
  return { profiles: profiles.length, matched, missing };
}

async function botLink() {
  const name = (await tg("getMe", {})).result?.username;
  return name ? `https://t.me/${name}` : "https://t.me";
}

// Google came back from the consent screen.
async function callback(params: URLSearchParams) {
  const who = await checkState(params.get("state"));
  const back = Response.redirect(await botLink(), 302);
  if (!who) return new Response("Посилання застаріло. Надішліть боту /google ще раз.", { status: 400 });
  const say = (text: string) => tg("sendMessage", { chat_id: who, text, parse_mode: "HTML" }).catch(console.error);
  if (params.get("error")) {
    await say(`Google не підключено: ви не дали дозвіл (${params.get("error")}). Надішліть /google, щоб спробувати ще раз.`);
    return back;
  }
  const c = client();
  if (!c) {
    await say("Google не підключено: на сервері ще немає GOOGLE_OAUTH_CLIENT_ID і GOOGLE_OAUTH_CLIENT_SECRET.");
    return back;
  }
  try {
    const t = await tokenCall({ code: params.get("code") ?? "", client_id: c.id, client_secret: c.secret, redirect_uri: SELF, grant_type: "authorization_code" });
    if (!t.refresh_token) throw new Error("Google не дав постійний доступ. Відкрийте myaccount.google.com/permissions, приберіть доступ «Кебабця» і надішліть /google ще раз.");
    await db.from("google_auth").upsert({ id: 1, refresh_token: t.refresh_token, connected_by: who, connected_at: new Date().toISOString(), last_sync: null, last_error: null });
    const m = await matchLocations(t.access_token);
    const lines = [`✅ <b>Google підключено.</b>`, `Профілів у цьому акаунті: ${m.profiles}. Знайшов наші точки: ${m.matched.length} з ${m.matched.length + m.missing.length}.`];
    if (m.missing.length) lines.push(`Не знайшов: ${m.missing.join(", ")}. Перешліть це повідомлення розробнику.`);
    lines.push("", "Перший збір усіх відгуків почнеться протягом 10 хвилин.");
    await say(lines.join("\n"));
  } catch (e) {
    await say(`Google не підключено: ${(e as Error).message}`);
  }
  return back;
}

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
// Google adds its own translation to a review in another language; keep the guest's words.
function original(comment: string | undefined) {
  const s = (comment ?? "").trim();
  const o = s.indexOf("(Original)");
  if (o >= 0) return s.slice(o + 10).trim();
  const t = s.indexOf("(Translated by Google)");
  return (t >= 0 ? s.slice(0, t) : s).trim();
}

type GReview = {
  name: string; reviewer?: { displayName?: string; isAnonymous?: boolean }; starRating?: string; comment?: string;
  createTime?: string; updateTime?: string; reviewReply?: { comment?: string; updateTime?: string };
};
type Loc = { id: number; name: string; gbp_name: string; gbp_synced_at: string | null };

// One location: pages newest-first until reviews older than the last sync (all pages the first time).
async function syncLocation(token: string, l: Loc, deadline: number) {
  const since = l.gbp_synced_at ? Date.parse(l.gbp_synced_at) - DAY : 0;
  const { data: known } = await db.from("google_reviews").select("id,gbp_name,author,published_at,updated_at").eq("location_id", l.id);
  const byName = new Map((known ?? []).filter((k) => k.gbp_name).map((k) => [k.gbp_name, k]));
  const placesOnly = (known ?? []).filter((k) => !k.gbp_name);
  const started = new Date().toISOString();
  let page = "", added = 0, complaints = 0, total = 0, avg = 0;
  do {
    if (Date.now() > deadline) return { added, complaints, done: false };
    const d = await google(`https://mybusiness.googleapis.com/v4/${l.gbp_name}/reviews?pageSize=50&orderBy=updateTime%20desc${page ? `&pageToken=${page}` : ""}`, token);
    total = d.totalReviewCount ?? total;
    avg = d.averageRating ?? avg;
    const reviews: GReview[] = d.reviews ?? [];
    for (const r of reviews) {
      const row = {
        location_id: l.id, rating: STARS[r.starRating ?? ""] ?? null, text: original(r.comment),
        author: r.reviewer?.isAnonymous ? "" : r.reviewer?.displayName ?? "", published_at: r.createTime ?? null,
        gbp_name: r.name, reply: r.reviewReply?.comment ?? null, reply_at: r.reviewReply?.updateTime ?? null, updated_at: r.updateTime ?? null,
      };
      const seen = byName.get(r.name);
      if (seen) {
        if (!seen.updated_at || Date.parse(seen.updated_at) !== Date.parse(r.updateTime ?? "")) {
          await db.from("google_reviews").update(row).eq("id", seen.id);
        }
        continue;
      }
      // Saved before by the Places check: same author, published within a day.
      const at = r.createTime ? Date.parse(r.createTime) : NaN;
      const old = placesOnly.find((k) => k.author === row.author && k.published_at && Math.abs(Date.parse(k.published_at) - at) < DAY);
      if (old) {
        await db.from("google_reviews").update(row).eq("id", old.id);
        placesOnly.splice(placesOnly.indexOf(old), 1);
        byName.set(r.name, { ...old, ...row });
        continue;
      }
      const { error } = await db.from("google_reviews").insert({ id: r.name, ...row });
      if (error) continue;
      byName.set(r.name, { id: r.name, ...row });
      added++;
      if (await googleComplaint(l, { ext: `google:${r.name}`, rating: row.rating, text: row.text, author: row.author, at: r.createTime ? new Date(r.createTime) : null })) complaints++;
    }
    const oldest = reviews.at(-1)?.updateTime;
    page = oldest && Date.parse(oldest) < since ? "" : d.nextPageToken ?? "";
  } while (page);
  await db.from("locations").update({ gbp_synced_at: started }).eq("id", l.id);
  return { added, complaints, done: true, total, avg };
}

async function sync() {
  let token: string | null;
  try {
    token = await accessToken();
  } catch (e) {
    await db.from("google_auth").update({ last_error: (e as Error).message }).eq("id", 1);
    return { ok: false, error: (e as Error).message };
  }
  if (!token) return { ok: false, reason: "Google ще не підключено" };
  const deadline = Date.now() + 100_000; // the platform stops a function at 150 s; the next run continues
  const { data } = await db.from("locations").select("id,name,gbp_name,gbp_synced_at").eq("active", true).not("gbp_name", "is", null).order("gbp_synced_at", { nullsFirst: true });
  const errors: string[] = [];
  let added = 0, complaints = 0, unfinished = 0;
  for (const l of (data ?? []) as Loc[]) {
    try {
      const r = await syncLocation(token, l, deadline);
      added += r.added;
      complaints += r.complaints;
      if (!r.done) unfinished++;
    } catch (e) {
      errors.push(`${l.name}: ${(e as Error).message}`);
    }
  }
  await db.from("google_auth").update({ last_sync: new Date().toISOString(), last_error: errors[0] ?? null }).eq("id", 1);
  return { ok: !errors.length, day: kyivToday(), locations: data?.length ?? 0, added, complaints, unfinished, errors };
}

Deno.serve(async (req) => {
  const params = new URL(req.url).searchParams;
  try {
    if (params.has("code") || params.has("error")) return await callback(params);
    const state = params.get("connect");
    if (state) {
      const c = client();
      if (!c) return new Response("На сервері ще немає GOOGLE_OAUTH_CLIENT_ID і GOOGLE_OAUTH_CLIENT_SECRET.", { status: 503 });
      if (!await checkState(state)) return new Response("Посилання застаріло. Надішліть боту /google ще раз.", { status: 400 });
      const q = new URLSearchParams({
        client_id: c.id, redirect_uri: SELF, response_type: "code", scope: SCOPE,
        access_type: "offline", prompt: "consent", state,
      });
      return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, 302);
    }
    if (params.has("sync")) return json(await sync());
    // Plain GET: is it connected, how many locations are matched (no secrets).
    const { data: auth } = await db.from("google_auth").select("connected_at,last_sync,last_error").maybeSingle();
    const { count } = await db.from("locations").select("id", { count: "exact", head: true }).eq("active", true).not("gbp_name", "is", null);
    return json({ client: !!client(), connected: !!auth, matched: count ?? 0, ...auth });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: (e as Error).message });
  }
});
