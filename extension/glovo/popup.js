const $ = (id) => document.getElementById(id);

async function show() {
  const { key, status } = await chrome.storage.local.get(["key", "status"]);
  $("keybox").style.display = key ? "none" : "";
  $("run").disabled = !key;
  const s = $("status");
  if (!key) { s.textContent = ""; return; }
  if (!status) { s.className = "ok"; s.textContent = "Ключ збережено. Чекаю на звіт."; return; }
  const at = new Date(status.at).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  s.className = status.ok ? "ok" : "bad";
  s.textContent = `${at}: ${status.text}`;
}

$("save").onclick = async () => {
  const key = $("key").value.trim();
  if (!/^\d+\.[0-9a-f]{32}$/.test(key)) { $("status").className = "bad"; $("status").textContent = "Це не схоже на ключ. Скопіюйте його з бота повністю."; return; }
  await chrome.storage.local.set({ key, status: null });
  chrome.action.setBadgeText({ text: "" });
  show();
};
$("run").onclick = () => { chrome.runtime.sendMessage({ type: "run" }); window.close(); };
$("open").onclick = () => chrome.tabs.create({ url: "https://portal.glovoapp.com/report-builder" });
chrome.storage.onChanged.addListener(show);
show();
