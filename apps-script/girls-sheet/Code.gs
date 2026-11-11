// «Кебабця: таблиця відгуків → апка» — Google Apps Script inside the girls' review sheet (2026-11-11).
// Every evening (and once right after setup) it sends this month's and last month's location tabs to the «Відгуки»
// bot. The bot adds every complaint the app does not have yet and only links the ones it already has, so nothing
// is added twice. The key comes from the bot's /glovo_key command and is kept only in this script's settings
// (Project Settings → Script Properties → BOT_KEY), never in the code.
const BOT_URL = "https://obpmsgxanigythxkvrmh.supabase.co/functions/v1/bot?girls_sheet=1";
const MONTHS = ["січ", "лют", "берез", "квіт", "трав", "черв", "лип", "серп", "верес", "жовт", "листоп", "груд"];

function sendToApp() {
  const key = PropertiesService.getScriptProperties().getProperty("BOT_KEY");
  if (!key) throw new Error("Немає ключа: Project Settings → Script Properties → BOT_KEY");
  const now = new Date();
  const want = [MONTHS[now.getMonth()], MONTHS[(now.getMonth() + 11) % 12]];
  const tabs = SpreadsheetApp.getActiveSpreadsheet().getSheets()
    .filter((s) => want.some((m) => s.getName().toLowerCase().includes(m)))
    .map((s) => ({ title: s.getName(), values: s.getRange(1, 1, Math.min(s.getLastRow(), 40), Math.min(s.getLastColumn(), 14)).getDisplayValues() }));
  const r = UrlFetchApp.fetch(BOT_URL, {
    method: "post", contentType: "application/json", payload: JSON.stringify({ tabs }),
    headers: { "x-glovo-key": key }, muteHttpExceptions: true,
  });
  console.log(tabs.length + " вкладок", r.getResponseCode(), r.getContentText().slice(0, 1000));
}

// Run once by hand: from now on it sends the sheet every day at about 21:00.
function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("sendToApp").timeBased().everyDays(1).atHour(21).create();
  sendToApp();
}
