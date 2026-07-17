// Store screenshot generator: real Chrome, real extension pages, seeded data.
// Output: ../store/screenshots/store-{popup,options,archive}-{light,dark}.png
// Run: cd test && node shots.mjs

import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
const OUT_DIR = path.resolve(__dirname, "../store/screenshots");
fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1)).replace(/[^\w -]/g, "") || "index";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<title>${name}</title>ok`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await puppeteer.launch({
  headless: true,
  args: [
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    "--no-first-run",
  ],
});
const target = await browser.waitForTarget(
  (t) => t.type() === "service_worker" && t.url().endsWith("background.js"),
);
const worker = await target.worker();
const swEval = (fn, ...args) => worker.evaluate(fn, ...args);
const extId = new URL(target.url()).host;

await swEval(() => globalThis.__ttForceSettle());

// Seed a believable world: a few grouped tabs + counters + archive entries.
const mk = async (title, active = false) =>
  swEval(
    (u, a) => new Promise((r) => chrome.tabs.create({ url: u, active: a }, (t) => r(t.id))),
    `http://127.0.0.1:${port}/${encodeURIComponent(title)}`,
    active,
  );
await mk("GitHub - pull requests");
await mk("GitHub - actions");
await mk("YouTube - talk on tab hygiene");
await mk("Docs - quarterly plan", true);
await sleep(1200);
await swEval(() => globalThis.__ttUiCall({ type: "ui:organizeNow", scope: "all" }));

const day = 86400e3;
const seedEntries = [
  ["Chrome Extensions - developer guide", "developer.chrome.com", "blue", "Docs", 0.2],
  ["Arc will archive your tabs - here's why", "arc.net", null, null, 0.3],
  ["Pricing - Linear", "linear.app", null, null, 0.5],
  ["The Verge - browser reviews", "theverge.com", "orange", "Reading", 1.1],
  ["MDN - chrome.tabGroups API", "developer.mozilla.org", "blue", "Docs", 1.2],
  ["Hacker News - tab hoarding thread", "news.ycombinator.com", "orange", "Reading", 1.4],
  ["Figma - onboarding flow v3", "figma.com", null, null, 2.2],
  ["Notion - team wiki", "notion.so", null, null, 2.5],
].map(([title, domain, color, group, age], i) => ({
  id: `shot-${i}`,
  url: `https://${domain}/${i}`,
  title,
  favUrl: null,
  domain,
  groupTitle: group,
  groupColor: color,
  winHint: 1,
  archivedAt: Date.now() - age * day,
  batchId: `shot-${Math.floor(age)}`,
  reason: "auto",
}));
await swEval((entries) => globalThis.__ttSeedArchive(entries), seedEntries);
await swEval(() => {
  const d = new Date(); // LOCAL date - the engine keys counters off local days
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  return chrome.storage.local.set({
    counters: { date, archivedToday: 12, dedupedToday: 7, sweptToday: 3 },
    lastBatch: { batchId: "shot-0", at: Date.now() - 600e3, count: 5 },
  });
});

async function shot(pageName, file, { width, height, scheme }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.goto(`chrome-extension://${extId}/${pageName}`, { waitUntil: "networkidle0" });
  await sleep(700);
  await page.screenshot({ path: path.join(OUT_DIR, file) });
  await page.close();
  console.log(`wrote ${file}`);
}

for (const scheme of ["light", "dark"]) {
  await shot("popup.html", `store-popup-${scheme}.png`, { width: 344, height: 560, scheme });
  await shot("options.html", `store-options-${scheme}.png`, { width: 1280, height: 800, scheme });
  await shot("archive.html", `store-archive-${scheme}.png`, { width: 1280, height: 800, scheme });
}

await browser.close();
server.close();
