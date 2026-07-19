// Dual-extension smoke: TrueTabs + TruePin live in ONE Chrome and speak the
// real family protocol over onMessageExternal - no mocks, no injected zones.
// This is the joint verify the unit suites cannot give: the browser attests
// the sender ids, TruePin broadcasts, TrueTabs reserves, and the strip holds
// still. Run AFTER both suites are green:  node family.mjs
import puppeteer from "puppeteer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRUETABS = path.resolve(__dirname, "../extension");
const TRUEPIN = path.resolve(__dirname, "../../truepin/extension");
const TIMEOUT = 90_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const watchdog = setTimeout(() => {
  console.error("family smoke: global timeout");
  process.exit(2);
}, TIMEOUT);
watchdog.unref();

const browser = await puppeteer.launch({
  headless: true,
  args: [
    `--disable-extensions-except=${TRUETABS},${TRUEPIN}`,
    `--load-extension=${TRUETABS},${TRUEPIN}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

async function swTarget(suffix) {
  const target = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().endsWith(suffix),
    { timeout: 30_000 },
  );
  return target.worker();
}

// Both workers up: poll until TWO service workers exist (either may spawn
// last), then identify each by its own globals - both files are named
// background.js.
let ttw = null;
let tpw = null;
for (let i = 0; i < 60 && !(ttw && tpw); i++) {
  const swTargets = browser.targets().filter((t) => t.type() === "service_worker");
  for (const t of swTargets) {
    const w = await t.worker();
    const which = await w
      .evaluate(() => (globalThis.__ttDiag ? "tt" : globalThis.__tpDiag ? "tp" : "?"))
      .catch(() => "?");
    if (which === "tt") ttw = w;
    if (which === "tp") tpw = w;
  }
  if (!(ttw && tpw)) await sleep(500);
}
check(!!ttw && !!tpw, "both service workers identified");
if (!ttw || !tpw) {
  await browser.close();
  process.exit(1);
}

// Force both engines past their cold-start gates.
await ttw.evaluate(() => globalThis.__ttForceSettle());
await sleep(400);

// A quiet world: one window, three regular pages.
const winInfo = await ttw.evaluate(async () => {
  const win = await chrome.windows.create({ url: "about:blank" });
  const a = await chrome.tabs.create({ windowId: win.id, url: "about:blank", active: false });
  const b = await chrome.tabs.create({ windowId: win.id, url: "about:blank", active: false });
  return { winId: win.id, first: (await chrome.tabs.query({ windowId: win.id }))[0].id };
});

// TruePin: always-front mode, then lock the first tab - the toggle both
// moves it and BROADCASTS the zone to TrueTabs over the real channel.
await tpw.evaluate(async () => {
  await chrome.storage.sync.set({ settings: { lockToFront: "always" } });
});
await sleep(600);
await tpw.evaluate((id) => globalThis.truePinToggle(id), winInfo.first);
await sleep(1200); // debounce + broadcast + apply

const zone = await ttw.evaluate(() => globalThis.__ttFamilyState());
check(zone.includes(winInfo.first), `the broadcast crossed extensions (zone=${JSON.stringify(zone)})`);

// The query path too: wipe and re-ask.
await ttw.evaluate(async () => {
  await globalThis.__ttFamilySet([]);
});
await ttw.evaluate(() => {
  // re-query the sibling exactly as settle does
  return new Promise((resolve) => {
    let done = false;
    for (const id of ["fkgkfmhkdgpeopigpbgohoblocpjakcf", "oappigoogllpddngpkmmdpfpbhcncnid"]) {
      try {
        chrome.runtime.sendMessage(id, { v: 1, type: "family:lockedFront:get" }, (resp) => {
          void chrome.runtime.lastError;
          if (resp && resp.v === 1 && !done) {
            done = true;
            resolve(resp);
          }
        });
      } catch {
        /* absent */
      }
    }
    setTimeout(() => resolve(null), 2000);
  });
}).then(async (resp) => {
  check(!!resp && resp.mode === "always", "the get/answer roundtrip works");
  if (resp) await ttw.evaluate((r) => globalThis.__ttFamilySet(r.tabIds), resp);
});

// No oscillation: five seconds of silence after both enforcers ran.
const before = await ttw.evaluate(
  async (winId) => (await chrome.tabs.query({ windowId: winId })).map((t) => `${t.id}:${t.index}`),
  winInfo.winId,
);
await sleep(5000);
const after = await ttw.evaluate(
  async (winId) => (await chrome.tabs.query({ windowId: winId })).map((t) => `${t.id}:${t.index}`),
  winInfo.winId,
);
check(JSON.stringify(before) === JSON.stringify(after), "five quiet seconds: zero oscillation");

// The locked tab holds the front of its window.
const lockedIndex = await ttw.evaluate(
  async (id) => (await chrome.tabs.get(id)).index,
  winInfo.first,
);
check(lockedIndex === 0, `the locked tab holds the front (index ${lockedIndex})`);

await browser.close();
console.log(failures === 0 ? "\nfamily smoke: all green" : `\nfamily smoke: ${failures} FAILURES`);
process.exit(failures ? 1 : 0);
