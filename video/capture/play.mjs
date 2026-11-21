// Player page flows: Alpha (answers at once) and Beta (answers later by webhook).
import { launch, sleep, clickText, APP } from "./lib.mjs";
import { record } from "./recorder.mjs";
const OUT = new URL("..", import.meta.url).pathname;

export async function spinning(page) {
  return page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Spinning"));
}
export async function coins(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent.trim() === "Your coins");
    const n = el?.parentElement?.innerText.replace(/\D+/g, " ").trim().split(" ").pop();
    return Number(n ?? 0);
  });
}
export async function hasButton(page, text) {
  return page.evaluate((t) => [...document.querySelectorAll("button")].some((b) => b.offsetParent && !b.disabled && b.innerText.trim().startsWith(t)), text);
}
// Deposit and spin until the player has at least `need` coins. Returns after the wheel stops.
export async function earn(page, need, rec) {
  for (let i = 0; i < 8 && (await coins(page)) < need; i++) {
    await clickText(page, "Deposit €20");
    rec?.mark("deposit");
    for (let k = 0; k < 40 && !(await hasButton(page, "Spin")); k++) await sleep(150);
    await sleep(900);
    await clickText(page, "Spin", "button.btn-big");
    rec?.mark("spin");
    await sleep(500);
    for (let k = 0; k < 80 && (await spinning(page)); k++) await sleep(150);
    await sleep(1500);
    rec?.mark(`coins ${await coins(page)}`);
  }
}
export async function openPlay(browser, tenant) {
  const page = await browser.newPage();
  await page.goto(`${APP}/app/#/play`, { waitUntil: "networkidle0" });
  await sleep(800);
  if (tenant) {
    await clickText(page, "Demo controls");
    await sleep(300);
    await clickText(page, tenant, ".demo-panel button");
    await sleep(1200);
    await clickText(page, "Demo controls");
    await sleep(800);
  }
  return page;
}
export async function redeem(page, rec) {
  await clickText(page, "Get Bonus", "button.btn-big");
  rec?.mark("get bonus");
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const which = process.argv[2] ?? "alpha";
  const browser = await launch();
  const page = await openPlay(browser, which === "beta" ? "Beta" : null);
  const rec = await record(page, `play-${which}`, OUT);
  await sleep(1500);
  await earn(page, 100, rec);
  await sleep(800);
  await redeem(page, rec);
  await sleep(which === "beta" ? 9000 : 5000);
  rec.mark("end");
  await rec.stop();
  await page.screenshot({ path: `${OUT}/capture/raw/play-${which}-end.png` });
  await browser.close();
}
