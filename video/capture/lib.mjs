// Shared helpers for the capture scripts: system Chrome at 1920x1080, scale 1.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
export const APP = process.env.APP_URL ?? "http://localhost:35080";
export const FAKE = process.env.FAKE_URL ?? "http://localhost:35081";
export async function launch() {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--window-size=1920,1080", "--hide-scrollbars", "--force-color-profile=srgb"],
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  });
  return browser;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function buttons(page) {
  return page.$$eval("button, a, input, select", (els) =>
    els.map((e) => `${e.tagName} ${e.getAttribute("type") ?? ""} ${(e.innerText || e.value || e.getAttribute("placeholder") || "").trim().slice(0, 60)}`),
  );
}
// Click the first visible element whose text contains `text`.
export async function clickText(page, text, sel = "button, a, [role=button], label") {
  const ok = await page.evaluate(
    (text, sel) => {
      const els = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null);
      const el = els.find((e) => e.innerText.trim().includes(text));
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.click();
      return true;
    },
    text,
    sel,
  );
  if (!ok) throw new Error(`no clickable element with text "${text}"`);
}
export function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}
