// Mini-app backend. Every request: POST { initData, action, ...args }; the Telegram user is taken from initData.
import * as XLSX from "npm:xlsx@0.18.5";
import { parseComplaint } from "../_shared/ai.ts";
import {
  activeLocations, bootstrapAdmin, channelsFor, CHANNELS, db, getUser, keywordTopics, kyivToday, newCode, redeemCode,
  RESULTS, ROLES, savePhoto, telegramUser, tg, TOPICS, type User,
} from "../_shared/common.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

class Fail extends Error {}
const must = (ok: unknown, msg: string) => {
  if (!ok) throw new Fail(msg);
};
const isStaff = (u: User) => u.role === "admin" || u.role === "comms";

function monthRange(month: string): [string, string] {
  must(/^\d{4}-\d{2}$/.test(month), "Невірний місяць");
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return [`${month}-01`, `${next}-01`];
}
function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

// Only what this user may see: a location admin sees their location, an operator sees what they entered.
// deno-lint-ignore no-explicit-any
function scope(q: any, u: User) {
  if (u.role === "loc_admin") return q.eq("location_id", u.location_id);
  if (u.role === "operator") return q.eq("created_by", u.tg_id);
  return q;
}

let botName = "";
async function botUsername(): Promise<string> {
  if (!botName) botName = (await tg("getMe", {})).result?.username ?? "";
  return botName;
}

async function monthData(u: User, month: string) {
  const [from] = monthRange(shiftMonth(month, -1));
  const [, to] = monthRange(month);
  const [sixFrom] = monthRange(shiftMonth(month, -5));
  const locations = await activeLocations();
  const cols = "id,location_id,channel,happened_on,text,topics,solution,result,who,photo_path,rating,source,created_by,created_at";
  const { data: items } = await scope(db.from("complaints").select(cols), u)
    .gte("happened_on", from).lt("happened_on", to).order("happened_on", { ascending: false }).order("id", { ascending: false });
  const { data: hist } = await scope(db.from("complaints").select("location_id,happened_on"), u)
    .gte("happened_on", sixFrom).lt("happened_on", to);
  const counts: Record<string, number> = {};
  for (const r of hist ?? []) {
    const k = `${r.location_id}|${String(r.happened_on).slice(0, 7)}`;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const { data: google } = await db.from("google_monthly").select("*").gte("month", sixFrom).lt("month", to);
  const { data: checks } = await db.from("checks_monthly").select("*").gte("month", from).lt("month", to);
  const { data: staff } = await db.from("users").select("name,role").eq("active", true).in("role", ["admin", "comms"]);
  return {
    month,
    locations: u.role === "loc_admin" ? locations.filter((l) => l.id === u.location_id) : locations,
    items: items ?? [],
    counts,
    google: google ?? [],
    checks: checks ?? [],
    who: (staff ?? []).map((s) => s.name),
  };
}

async function exportMonth(u: User, month: string) {
  const [from, to] = monthRange(month);
  const locations = await activeLocations();
  const { data: rows } = await scope(db.from("complaints").select("*"), u)
    .gte("happened_on", from).lt("happened_on", to).order("happened_on");
  const { data: google } = await db.from("google_monthly").select("*").eq("month", from);
  const { data: checks } = await db.from("checks_monthly").select("*").eq("month", from);
  const aoa: (string | number)[][] = [["ЗАКЛАД", "ДАТА", "СОЦМЕРЕЖА", "СУТЬ ПРОБЛЕМИ", "РІШЕННЯ", "РЕЗУЛЬТАТ", "ХТО ВІВ"]];
  for (const l of locations) {
    const mine = (rows ?? []).filter((r: { location_id: number }) => r.location_id === l.id);
    const g = (google ?? []).find((x) => x.location_id === l.id);
    const c = (checks ?? []).find((x) => x.location_id === l.id);
    if (!mine.length && !g && !c) continue;
    aoa.push([l.name]);
    for (const r of mine) {
      aoa.push(["", r.happened_on.split("-").reverse().join("."), r.channel, r.text, r.solution, r.result, r.who]);
    }
    if (g) {
      aoa.push([`відгуків у Google - ${g.total ?? ""} (нових ${g.new_reviews ?? ""})`]);
      aoa.push([`Позитивні - ${g.positive ?? ""}`], [`Негативні - ${g.negative ?? ""}`]);
      aoa.push([`Початкова оцінка місяця - ${g.start_rating ?? ""}`], [`Кінцева оцінка місяця - ${g.end_rating ?? ""}`]);
    }
    if (c) aoa.push([`Чеків за місяць - ${c.checks}; скарг - ${mine.length} (${c.checks ? ((mine.length / c.checks) * 100).toFixed(2) : "—"}%)`]);
    aoa.push([]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 28 }, { wch: 11 }, { wch: 16 }, { wch: 60 }, { wch: 45 }, { wch: 28 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, month);
  const bytes: ArrayBuffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const form = new FormData();
  form.append("chat_id", String(u.tg_id));
  form.append("caption", `Скарги за ${month}`);
  form.append("document", new Blob([bytes]), `vidguky-${month}.xlsx`);
  const res = await fetch(`https://api.telegram.org/bot${Deno.env.get("TELEGRAM_BOT_TOKEN")}/sendDocument`, { method: "POST", body: form });
  must((await res.json()).ok, "Не вдалося надіслати файл. Спершу відкрийте чат з ботом і натисніть «Старт».");
}

// deno-lint-ignore no-explicit-any
async function handle(u: User, a: string, p: any): Promise<unknown> {
  switch (a) {
    case "me":
      return { user: u, roles: ROLES, channels: channelsFor(u.role), allChannels: CHANNELS, topics: TOPICS, results: RESULTS, bot: await botUsername(), today: kyivToday() };

    case "data":
      return monthData(u, p.month);

    case "photo": {
      const { data: c } = await scope(db.from("complaints").select("photo_path"), u).eq("id", p.id).maybeSingle();
      must(c?.photo_path, "Фото немає");
      const { data } = await db.storage.from("photos").createSignedUrl(c!.photo_path, 600);
      return { url: data?.signedUrl };
    }

    case "parse": {
      const image = p.photo ? { data: String(p.photo.data), mime: String(p.photo.mime) } : undefined;
      return parseComplaint(await activeLocations(), { text: p.text, image });
    }

    case "add": {
      const locId = u.role === "loc_admin" ? u.location_id : Number(p.location_id);
      must(locId, "Виберіть точку");
      must(channelsFor(u.role).includes(p.channel), "Виберіть канал");
      const text = String(p.text ?? "").trim();
      must(text, "Опишіть суть проблеми");
      const solution = String(p.solution ?? "").trim();
      const row = {
        location_id: locId,
        channel: p.channel,
        happened_on: /^\d{4}-\d{2}-\d{2}$/.test(p.date ?? "") ? p.date : kyivToday(),
        text,
        topics: Array.isArray(p.topics) && p.topics.length ? p.topics.filter((t: string) => TOPICS.includes(t)) : keywordTopics(text),
        solution,
        result: solution && isStaff(u) ? (RESULTS.includes(p.result) ? p.result : "Владнано") : "",
        who: solution && isStaff(u) ? String(p.who || u.name) : "",
        resolved_at: solution && isStaff(u) ? new Date().toISOString() : null,
        rating: Number.isInteger(p.rating) && p.rating > 0 ? p.rating : null,
        source: "app",
        created_by: u.tg_id,
      };
      const { data, error } = await db.from("complaints").insert(row).select().single();
      must(!error, "Не вдалося зберегти");
      if (p.photo?.data) {
        const bin = Uint8Array.from(atob(p.photo.data), (c) => c.charCodeAt(0));
        data.photo_path = await savePhoto(data.id, bin, p.photo.mime);
      }
      return data;
    }

    case "save": {
      must(isStaff(u), "Рішення записують комунікаційники");
      const solution = String(p.solution ?? "").trim();
      must(solution && RESULTS.includes(p.result), "Запишіть рішення і виберіть результат");
      const { data, error } = await db.from("complaints").update({
        solution, result: p.result, who: String(p.who ?? ""), updated_at: new Date().toISOString(), resolved_at: new Date().toISOString(),
      }).eq("id", p.id).select().single();
      must(!error, "Не вдалося зберегти");
      return data;
    }

    case "export":
      await exportMonth(u, p.month);
      return { ok: true };

    case "collabs": {
      const { data } = await db.from("collabs").select("*").order("happened_on", { ascending: false }).limit(200);
      return data ?? [];
    }
    case "collab_add": {
      must(isStaff(u), "Немає доступу");
      must(String(p.event ?? "").trim(), "Опишіть подію");
      const row = {
        happened_on: /^\d{4}-\d{2}-\d{2}$/.test(p.date ?? "") ? p.date : kyivToday(),
        event: String(p.event).trim(), partner: String(p.partner ?? ""), ours: String(p.ours ?? ""), theirs: String(p.theirs ?? ""),
        pros: String(p.pros ?? ""), cons: String(p.cons ?? ""), result: String(p.result ?? ""), created_by: u.tg_id,
      };
      const { data } = await db.from("collabs").insert(row).select().single();
      return data;
    }

    // ---- administrator only ----
    case "users": {
      must(u.role === "admin", "Немає доступу");
      const { data: users } = await db.from("users").select("*").eq("active", true).order("created_at");
      const { data: invites } = await db.from("invites").select("*").is("used_by", null).order("created_at", { ascending: false });
      return { users: users ?? [], invites: invites ?? [] };
    }
    case "invite": {
      must(u.role === "admin", "Немає доступу");
      must(ROLES[p.role], "Виберіть роль");
      must(p.role !== "loc_admin" || p.location_id, "Виберіть точку");
      must(String(p.name ?? "").trim(), "Вкажіть ім'я");
      const code = newCode();
      await db.from("invites").insert({ code, role: p.role, location_id: p.role === "loc_admin" ? p.location_id : null, name: String(p.name).trim(), created_by: u.tg_id });
      return { code, link: `https://t.me/${await botUsername()}?start=${code}` };
    }
    case "invite_del":
      must(u.role === "admin", "Немає доступу");
      await db.from("invites").delete().eq("code", p.code).is("used_by", null);
      return { ok: true };
    case "user_off":
      must(u.role === "admin", "Немає доступу");
      must(p.tg_id !== u.tg_id, "Себе вимкнути не можна");
      await db.from("users").update({ active: false }).eq("tg_id", p.tg_id);
      return { ok: true };
    case "checks_save": {
      must(u.role === "admin", "Немає доступу");
      const [from] = monthRange(p.month);
      const rows = Object.entries(p.values ?? {})
        .filter(([, v]) => v !== "" && v !== null && Number(v) >= 0)
        .map(([id, v]) => ({ location_id: Number(id), month: from, checks: Math.round(Number(v)) }));
      if (rows.length) await db.from("checks_monthly").upsert(rows);
      return { ok: true };
    }
    case "loc_save": {
      must(u.role === "admin", "Немає доступу");
      const name = String(p.name ?? "").trim();
      must(name, "Вкажіть назву");
      const row = {
        name,
        city: String(p.city ?? "").trim() || name.split(",")[0].trim(),
        aliases: String(p.aliases ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      };
      const q = p.id ? db.from("locations").update(row).eq("id", p.id) : db.from("locations").insert(row);
      const { error } = await q;
      must(!error, "Така точка вже є");
      return { ok: true };
    }
    case "loc_all": {
      must(u.role === "admin", "Немає доступу");
      const { data } = await db.from("locations").select("*").order("name");
      return data ?? [];
    }
  }
  throw new Fail("Невідома дія");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method === "GET") {
    // Keep-alive ping from the GitHub schedule: touches the database so the free project is not paused.
    const { count } = await db.from("locations").select("id", { count: "exact", head: true });
    return json({ ok: true, locations: count });
  }
  try {
    const p = await req.json();
    const from = await telegramUser(p.initData);
    if (!from) return json({ error: "Відкрийте апку через бота в Telegram" }, 401);
    let u = await getUser(from.id);
    if (!u && p.action === "redeem") {
      u = await redeemCode(String(p.code ?? ""), from);
      if (!u) return json({ error: "Код не підходить або вже використаний" }, 400);
      return json({ ok: true });
    }
    if (!u) u = await bootstrapAdmin(from);
    if (!u) return json({ needCode: true }, 403);
    return json(await handle(u, p.action, p));
  } catch (e) {
    if (e instanceof Fail) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: "Помилка сервера, спробуйте ще раз" }, 500);
  }
});
