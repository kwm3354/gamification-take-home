// The lost answer: arm the fault on the control panel, redeem on the player page, check on the panel.
import { launch, sleep, clickText, FAKE } from "./lib.mjs";
import { record } from "./recorder.mjs";
import { openPlay, earn, redeem } from "./play.mjs";
const OUT = new URL("..", import.meta.url).pathname;

const browser = await launch();
const panel = await browser.newPage();
await panel.goto(FAKE, { waitUntil: "networkidle0" });
await sleep(800);
const r1 = await record(panel, "fail-arm", OUT);
await sleep(1500);
// The first "Switch on" belongs to "The casino issues the bonus, but its answer is lost"; platform A is preselected.
await panel.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Switch on").click());
r1.mark("armed");
await sleep(2500);
await r1.stop();
await panel.screenshot({ path: `${OUT}/capture/raw/fail-armed.png` });

const play = await openPlay(browser, null);
// A fresh player for this scene: the demo panel can create one.
await clickText(play, "Demo controls");
await sleep(300);
await clickText(play, "New player", ".demo-panel button").catch(() => clickText(play, "player", ".demo-panel button"));
await sleep(1200);
await clickText(play, "Demo controls");
await sleep(800);
await earn(play, 100, null);
await sleep(500);
const r2 = await record(play, "fail-redeem", OUT);
await sleep(1200);
await redeem(play, r2);
await sleep(9000);
r2.mark("end");
await r2.stop();
await play.screenshot({ path: `${OUT}/capture/raw/fail-redeem-end.png` });

await panel.bringToFront();
await panel.reload({ waitUntil: "networkidle0" });
await sleep(800);
const r3 = await record(panel, "fail-check", OUT);
await panel.evaluate(() => [...document.querySelectorAll("h2,h3")].find((h) => h.innerText.startsWith("2."))?.scrollIntoView({ behavior: "smooth", block: "start" }));
await sleep(2500);
r3.mark("record");
await clickText(panel, "Check now");
await sleep(1000);
await panel.evaluate(() => [...document.querySelectorAll("h2,h3")].find((h) => h.innerText.startsWith("3."))?.scrollIntoView({ behavior: "smooth", block: "start" }));
r3.mark("checked");
await sleep(3500);
await r3.stop();
await panel.screenshot({ path: `${OUT}/capture/raw/fail-check-end.png`, fullPage: true });
await browser.close();
