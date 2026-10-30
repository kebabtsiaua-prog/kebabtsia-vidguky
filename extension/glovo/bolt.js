// Runs on Bolt Merchant. Bolt has no reviews file, so whenever «Оцінки та відгуки» is open the extension reads the
// table (stars, date, tags, text) of the chosen store and sends it to the bot (2026-10-30).
let lastSent = "";
let shownCell = false;

const leaves = (root) => [...root.querySelectorAll("*")].filter((el) => !el.children.length && el.textContent.trim());
const chip = (el) => /rounded|chip|tag|badge/i.test(`${el.className} ${el.parentElement?.className ?? ""}`);

function readRow(tr) {
  const id = (tr.getAttribute("data-testid") ?? "").split(".").pop();
  const stars = tr.querySelector('[data-testid$="Row.Rating"] [aria-label]')?.getAttribute("aria-label") ?? "";
  const at = tr.querySelector('[data-testid$="Row.Date"]')?.textContent.trim() ?? "";
  const cell = tr.querySelector('[data-testid$="Row.Comment"]');
  const parts = cell ? leaves(cell) : [];
  let tags = parts.filter(chip), words = parts.filter((el) => !chip(el));
  // No chip classes on the page: short pieces before the last one are tags, a long last piece is the text.
  if (!tags.length && parts.length) {
    const last = parts[parts.length - 1];
    words = last.textContent.trim().length > 25 ? [last] : [];
    tags = parts.filter((el) => !words.includes(el));
  }
  return {
    id, at, rating: Number(stars.match(/\d/)?.[0]) || null,
    tags: tags.map((el) => el.textContent.trim()), text: words.map((el) => el.textContent.trim()).join(" "),
    cell: cell && parts.length && !shownCell ? cell.innerHTML.slice(0, 1500) : undefined,
  };
}

function storeName() {
  const side = document.querySelector("nav, aside");
  return side ? leaves(side)[0]?.textContent.trim() ?? "" : "";
}

function read() {
  if (!location.pathname.includes("rating-and-feedback")) return;
  const rows = [...document.querySelectorAll('[data-testid*="CommentsTable.Row.View"]')].map(readRow).filter((r) => r.id && r.at);
  const store = storeName();
  if (!rows.length || !store) return;
  const sample = rows.find((r) => r.cell)?.cell;
  rows.forEach((r) => delete r.cell);
  const key = JSON.stringify([store, rows]);
  if (key === lastSent) return;
  lastSent = key;
  if (sample) {
    shownCell = true;
    chrome.runtime.sendMessage({ type: "diag", diag: { via: "bolt", why: "cell", store, sample, first: rows.slice(0, 4) } });
  }
  chrome.runtime.sendMessage({ type: "bolt", store, rows });
}

// The page fills the table after loading and again after a store or a period is chosen.
let timer = null;
new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(read, 2000); }).observe(document.documentElement, { childList: true, subtree: true });
