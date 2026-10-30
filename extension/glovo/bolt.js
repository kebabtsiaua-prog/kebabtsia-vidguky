// Runs on Bolt Merchant. For now it only shows the developer how the reviews page is built (owner 2026-10-30:
// «повертаємося до болта»), so the next version can read the reviews table and send it to the bot.
let sent = 0;
const seen = new Set();

function snapshot(why) {
  if (!location.pathname.includes("rating-and-feedback") || sent >= 8) return;
  const head = [...document.querySelectorAll("body *")].find((el) => el.children.length === 0 && el.textContent.trim() === "Відгук");
  let table = head;
  // Climb from the «Відгук» column title to the block that holds several dated rows.
  while (table?.parentElement && (table.textContent.match(/\d\d\.\d\d\.\d{4}/g) ?? []).length < 3) table = table.parentElement;
  const popups = [...document.querySelectorAll("[role=listbox], [role=menu], [role=dialog], [role=option]")].map((el) => el.outerHTML.slice(0, 3000));
  const diag = {
    via: "bolt", why, page: location.href, title: document.title,
    store: document.querySelector("nav, aside")?.textContent.trim().slice(0, 200) ?? "",
    table: table?.outerHTML.slice(0, 6000) ?? null,
    popups: popups.slice(0, 3),
  };
  const key = JSON.stringify([diag.table?.length, diag.popups.join("").length, diag.page]);
  if (seen.has(key)) return;
  seen.add(key);
  sent++;
  chrome.runtime.sendMessage({ type: "diag", diag });
}

setTimeout(() => snapshot("load"), 5000);
document.addEventListener("click", () => setTimeout(() => snapshot("click"), 1500), true);
