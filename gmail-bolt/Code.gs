// «Кебабця: звіт Bolt» — Google Apps Script in the owner's Gmail (2026-11-09).
// Bolt emails «Ratings_and_Comments_<date>.xlsx» every day. Every hour this script looks for new such emails,
// sends the attached file to the «Відгуки» bot and marks the email with the label «Відгуки Bolt», so each file
// goes once. The key comes from the bot's /glovo_key command and is kept only in this script's settings
// (Project Settings → Script Properties → BOT_KEY), never in the code.
const BOT_URL = "https://obpmsgxanigythxkvrmh.supabase.co/functions/v1/bot?bolt_xlsx=1";
const LABEL = "Відгуки Bolt";

function sendBoltReports() {
  const key = PropertiesService.getScriptProperties().getProperty("BOT_KEY");
  if (!key) throw new Error("Немає ключа: Project Settings → Script Properties → BOT_KEY");
  const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  const threads = GmailApp.search(`has:attachment filename:Ratings_and_Comments newer_than:7d -label:"${LABEL}"`);
  for (const t of threads) {
    let ok = true;
    for (const m of t.getMessages()) {
      for (const a of m.getAttachments()) {
        if (!/^Ratings_and_Comments.*\.xlsx$/i.test(a.getName())) continue;
        const r = UrlFetchApp.fetch(BOT_URL, {
          method: "post", contentType: "application/octet-stream", payload: a.getBytes(),
          headers: { "x-glovo-key": key }, muteHttpExceptions: true,
        });
        console.log(a.getName(), r.getResponseCode(), r.getContentText().slice(0, 500));
        if (r.getResponseCode() !== 200) ok = false;
      }
    }
    if (ok) t.addLabel(label);
  }
}

// Run once by hand: checks every hour from now on.
function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("sendBoltReports").timeBased().everyHours(1).create();
  sendBoltReports();
}
