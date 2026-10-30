// Runs next to the Glovo portal page: passes the report to background.js and clicks «Завантажити» when asked.
const DOWNLOAD = /^(завантажити|завантажити файл|download|download file)$/i;
let clicked = "";

document.addEventListener("click", (e) => {
  const el = e.target instanceof Element && e.target.closest("button, a, [role=button], [role=menuitem]");
  if (!el) return;
  clicked = el.outerHTML.slice(0, 600);
  chrome.runtime.sendMessage({ type: "click", page: location.href, clicked });
}, true);

window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data?.kebabtsiaGlovo) return;
  chrome.runtime.sendMessage({ type: "csv", csv: e.data.csv, diag: { via: "blob", page: location.href, clicked } });
});

const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

// Every element, also inside web components (shadow DOM), which the portal's design system may use.
function deepAll(root = document) {
  const out = [];
  for (const el of root.querySelectorAll("*")) {
    out.push(el);
    if (el.shadowRoot) out.push(...deepAll(el.shadowRoot));
  }
  return out;
}
const named = (el) => [...el.attributes].some((a) => DOWNLOAD.test(a.value.trim()));
const said = (el) => DOWNLOAD.test(el.textContent.trim()) && ![...el.children].some((c) => DOWNLOAD.test(c.textContent.trim()));

// The first «Завантажити» on the page is the newest report. On the reports page it is not a plain <button>.
function findDownload() {
  const els = deepAll().filter((el) => el.tagName !== "SCRIPT" && el.tagName !== "STYLE" && visible(el));
  return els.find(said) ?? els.find(named);
}

// What the page offers, so the developer can teach the extension the right button if the portal changes.
function snapshot() {
  const all = deepAll();
  const row = all.find((el) => el.children.length === 0 && /^Відгуки щодня$/.test(el.textContent.trim()));
  let box = row;
  for (let i = 0; box && i < 6 && !/\d{4}/.test(box.textContent); i++) box = box.parentElement ?? box.getRootNode().host;
  return {
    page: location.href,
    title: document.title,
    visible: document.visibilityState,
    shadows: all.filter((el) => el.shadowRoot).length,
    buttons: [...document.querySelectorAll("button, a, [role=button], [role=menuitem]")].filter(visible).slice(0, 60)
      .map((el) => (el.textContent.trim() || el.getAttribute("aria-label") || el.title || "").slice(0, 60)),
    row: (box?.parentElement ?? box)?.outerHTML.slice(0, 3000) ?? null,
    found: all.filter((el) => /завантаж/i.test(el.textContent) && el.children.length === 0).slice(0, 4).map((el) => el.outerHTML.slice(0, 200)),
  };
}

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m.type !== "auto") return;
  const started = Date.now();
  (function wait() {
    const el = findDownload();
    if (el) {
      clicked = el.outerHTML.slice(0, 600);
      el.click();
      reply({ ...snapshot(), found: true, clicked });
    } else if (Date.now() - started > 30000) reply({ ...snapshot(), found: false });
    else setTimeout(wait, 1500);
  })();
  return true;
});
