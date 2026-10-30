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
function findDownload() {
  const els = [...document.querySelectorAll("button, a, [role=button], [role=menuitem]")].filter(visible);
  return els.find((el) => DOWNLOAD.test(el.textContent.trim()))
    ?? els.find((el) => /завантаж|download/i.test(el.getAttribute("aria-label") ?? el.title ?? ""))
    // On the reports page «Завантажити» is not a button but a plain element; the first one is the newest report.
    ?? [...document.querySelectorAll("body *")].find((el) =>
      visible(el) && DOWNLOAD.test(el.textContent.trim()) && ![...el.children].some((c) => DOWNLOAD.test(c.textContent.trim())));
}

// What the page offers, so the developer can teach the extension the right button if the portal changes.
function snapshot() {
  return {
    page: location.href,
    title: document.title,
    buttons: [...document.querySelectorAll("button, a, [role=button], [role=menuitem]")].filter(visible).slice(0, 60)
      .map((el) => (el.textContent.trim() || el.getAttribute("aria-label") || el.title || "").slice(0, 60)),
    downloads: [...document.querySelectorAll("body *")].filter((el) => /^завантажити$/i.test(el.textContent.trim())).slice(0, 6)
      .map((el) => el.outerHTML.slice(0, 300)),
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
      reply({ found: true, ...snapshot(), clicked });
    } else if (Date.now() - started > 45000) reply({ found: false, ...snapshot() });
    else setTimeout(wait, 1500);
  })();
  return true;
});
