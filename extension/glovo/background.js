// Takes the Glovo «Відгуки щодня» report and sends it to the bot, which adds negative reviews as complaints.
// Two ways in: the owner presses «Завантажити» on the portal, or every evening the extension opens the portal itself.
const API = "https://obpmsgxanigythxkvrmh.supabase.co/functions/v1/bot?glovo_csv=1";
const REPORTS = "https://portal.glovoapp.com/report-builder";
const AUTO_AT = { hour: 18, minute: 50 }; // the email with the report comes at about 18:30 Kyiv time

const looksLikeReport = (t) => /замовлен|order/i.test(t.slice(0, 2000)) && /відгук|review/i.test(t.slice(0, 2000));
const today = () => new Date().toLocaleDateString("sv");
let lastClick = null;
let autoTab = null;
let autoStarted = 0;
const pending = new Set();

async function setStatus(text, ok) {
  await chrome.storage.local.set({ status: { text, ok, at: new Date().toISOString() } });
  chrome.action.setBadgeText({ text: ok ? "" : "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#E5484D" });
}

async function hash(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function post(body) {
  const { key } = await chrome.storage.local.get("key");
  if (!key) return { ok: false, error: "nokey" };
  try {
    const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json", "x-glovo-key": key }, body: JSON.stringify(body) });
    return await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  } catch (e) {
    return { ok: false, error: "offline" };
  }
}

async function send(csv, diag) {
  const h = await hash(csv);
  const { sent = [] } = await chrome.storage.local.get("sent");
  if (sent.includes(h) || pending.has(h)) return; // the same file seen twice (blob and download)
  pending.add(h);
  const out = await post({ csv, diag }).finally(() => pending.delete(h));
  if (out.ok) {
    await chrome.storage.local.set({ sent: [h, ...sent].slice(0, 30), lastDay: today() });
    const days = (out.days ?? []).map((d) => d.split("-").reverse().slice(0, 2).join(".")).join(", ");
    await setStatus(`Звіт${days ? ` за ${days}` : ""} надіслано (відгуків: ${out.rows}, нових скарг: ${out.complaints}). Підсумок у боті.`, true);
    if (autoTab !== null) chrome.tabs.remove(autoTab).catch(() => {});
    autoTab = null;
  } else {
    await setStatus({
      nokey: "Вставте ключ від бота (команда /glovo_key).",
      key: "Ключ не підходить. Візьміть новий у боті командою /glovo_key.",
      offline: "Немає інтернету, звіт не надіслано.",
      "not a report": "Завантажений файл не схожий на звіт «Відгуки щодня».",
    }[out.error] ?? `Помилка сервера: ${out.error}`, false);
  }
}

chrome.runtime.onMessage.addListener((m, sender) => {
  if (m.type === "click") lastClick = { page: m.page, clicked: m.clicked, at: Date.now() };
  if (m.type === "csv") send(m.csv, m.diag);
  if (m.type === "run") runAuto();
});

// A download from the portal: fetch the same link (the browser is logged in) and send its text.
chrome.downloads.onCreated.addListener(async (item) => {
  const url = item.finalUrl || item.url;
  if (!/^https:/.test(url)) return;
  const fromGlovo = /glovoapp\.com/.test(item.referrer ?? "") || (lastClick && Date.now() - lastClick.at < 60000);
  if (!fromGlovo && !/csv/i.test(item.mime ?? "")) return;
  try {
    const text = await (await fetch(url, { credentials: "include" })).text();
    if (!looksLikeReport(text)) return;
    const u = new URL(url);
    await send(text, { via: "download", host: u.host, path: u.pathname, mime: item.mime, ...(lastClick ?? {}) });
  } catch (e) {
    await setStatus("Не вдалося прочитати завантажений файл. Перешліть його в бот вручну.", false);
  }
});

// Every evening: open the reports page in a background tab and press «Завантажити».
async function runAuto() {
  if (autoTab !== null && Date.now() - autoStarted < 180000) return;
  autoStarted = Date.now();
  const tab = await chrome.tabs.create({ url: REPORTS, active: false });
  autoTab = tab.id;
  await chrome.storage.local.set({ autoTried: today() });
  // Ask the page until it answers: waiting for «complete» missed a page that came from cache before the listener was set.
  let res;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    res = await chrome.tabs.sendMessage(tab.id, { type: "auto" }).catch((e) => ({ found: false, error: String(e.message ?? e) }));
    if (!res.error) break;
    if (i === 9) await chrome.tabs.reload(tab.id).catch(() => {}); // the page did not open (no internet after sleep)
  }
  await post({ diag: { via: "auto", ...res } });
  if (!res.found) {
    await setStatus(/login|auth|sign/i.test(res.page ?? "") ? "Увійдіть у портал Glovo в цьому Chrome, тоді натисніть «Забрати звіт зараз»."
      : "Не знайшов кнопку «Завантажити». Відкрийте звіт із листа й натисніть її самі, розширення надішле файл.", false);
    chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    autoTab = null;
  } else setTimeout(() => { if (autoTab === tab.id) { chrome.tabs.remove(tab.id).catch(() => {}); autoTab = null; } }, 120000);
}

function nextAuto() {
  const t = new Date();
  t.setHours(AUTO_AT.hour, AUTO_AT.minute, 0, 0);
  if (t <= new Date()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

async function catchUp() {
  const { lastDay, autoTried } = await chrome.storage.local.get(["lastDay", "autoTried"]);
  const late = new Date().getHours() * 60 + new Date().getMinutes() >= AUTO_AT.hour * 60 + AUTO_AT.minute;
  if (late && lastDay !== today() && autoTried !== today()) runAuto();
}

chrome.tabs.onRemoved.addListener((id) => { if (id === autoTab) autoTab = null; }); // closed by hand: the next press starts again

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create("auto", { when: nextAuto(), periodInMinutes: 24 * 60 }));
chrome.runtime.onStartup.addListener(catchUp); // the Mac was asleep or Chrome closed at 18:50
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "auto") catchUp(); });
