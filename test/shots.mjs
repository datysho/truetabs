// Store screenshot generator: real Chrome, real extension pages, seeded data.
// Output: ../store/screenshots/store-{popup,options,archive}-{light,dark}.png
// Run: cd test && node shots.mjs

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
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
    // Every hostname resolves to the local server, so the seeded tabs carry
    // REAL domains and site grouping names the groups the way a user's browser
    // would: "Github", "Youtube". On 127.0.0.1 every tab shares one domain and
    // the shot advertised grouping with a group called "127". No network is
    // touched - the resolver never leaves the loopback.
    `--host-resolver-rules=MAP * 127.0.0.1:${port}`,
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
// The host carries the domain (and so the group name), the path the title.
const mk = async (host, title, active = false) =>
  swEval(
    (u, a) => new Promise((r) => chrome.tabs.create({ url: u, active: a }, (t) => r(t.id))),
    `http://${host}/${encodeURIComponent(title)}`,
    active,
  );
await mk("github.com", "Pull requests");
await mk("github.com", "Actions - all workflows");
await mk("youtube.com", "A talk on tab hygiene");
await mk("youtube.com", "Arc browser - a retrospective");
await mk("docs.google.com", "Quarterly plan", true);
await sleep(1500);
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

// The store takes EXACTLY 1280x800 (or 640x400) - a @2x render is rejected at
// upload, so these are shot at deviceScaleFactor 1 and are upload-ready as-is.
async function shot(pageName, file, { scheme }) {
  const page = await browser.newPage();
  await page.setViewport({ width: CWS.w, height: CWS.h, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.goto(`chrome-extension://${extId}/${pageName}`, { waitUntil: "networkidle0" });
  await sleep(700);
  await page.screenshot({ path: path.join(OUT_DIR, file) });
  await page.close();
  console.log(`wrote ${file}`);
}

const CWS = { w: 1280, h: 800 };
const TILE = { w: 440, h: 280 }; // the store's small promo tile
const MARQUEE = { w: 1400, h: 560 }; // the store's marquee (featured carousel)

// One composition, three canvases - and the same type on all three would be
// wrong on two of them: the tile is a thumbnail read at a glance, the marquee
// is a banner shown at full width. Each canvas names its own scale instead of
// deriving it from the width, so a new size cannot silently inherit type that
// was tuned for a different one.
const SCALE = {
  tile: { padR: 24, padL: 28, gap: 10, brandMb: 12, icon: 34, radius: 8, name: 25, h1: 17, subTop: 8, sub: 11 },
  screenshot: { padR: 56, padL: 72, gap: 16, brandMb: 28, icon: 60, radius: 13, name: 44, h1: 34, subTop: 18, sub: 18 },
  marquee: { padR: 64, padL: 88, gap: 18, brandMb: 30, icon: 72, radius: 16, name: 54, h1: 40, subTop: 20, sub: 21 },
};

// The popup is 344 wide: it cannot BE a store screenshot, it has to be placed
// on one. Same composition as the social image, sized for the store canvas.
const PANEL = {
  light: {
    bg: "linear-gradient(135deg, #f7f9fc 0%, #eef3f9 55%, #e6edf6 100%)",
    fg: "#212835",
    sub: "#5b6472",
    shadow: "0 24px 64px rgba(20, 35, 60, 0.18), 0 4px 16px rgba(20, 35, 60, 0.10)",
    border: "none",
    popupBg: "#ffffff",
  },
  dark: {
    bg: "linear-gradient(135deg, #0f1319 0%, #151b24 55%, #1a222d 100%)",
    fg: "#dfe4ea",
    sub: "#98a2b0",
    shadow: "0 24px 64px rgba(0, 0, 0, 0.55), 0 4px 16px rgba(0, 0, 0, 0.35)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
    popupBg: "#292a2d",
  },
};
const dataUri = (file) => `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
const iconUri = dataUri(path.join(EXTENSION_DIR, "icons", "tt-128.png"));

async function shotPopupRaw(scheme) {
  const page = await browser.newPage();
  await page.setViewport({ width: 344, height: 700, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "networkidle0" });
  await page.waitForFunction(
    () =>
      document.body.classList.contains("ready") &&
      document.getElementById("tabCount").textContent !== "-",
    { timeout: 5000 },
  );
  await sleep(500);
  const file = path.join(os.tmpdir(), `truetabs-shot-popup-${scheme}-${process.pid}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  return file;
}

async function compose(scheme, popupFile, { size, scale, file, headline, sub, popupW, popupTop }) {
  const t = PANEL[scheme];
  const z = SCALE[scale];
  const page = await browser.newPage();
  await page.setViewport({ width: size.w, height: size.h, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><html><head><style>
      * { margin: 0; box-sizing: border-box; }
      body {
        width: ${size.w}px; height: ${size.h}px; overflow: hidden;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: ${t.bg}; display: flex; align-items: center;
      }
      .left { flex: 1; padding: 0 ${z.padR}px 0 ${z.padL}px; }
      .brand { display: flex; align-items: center; gap: ${z.gap}px; margin-bottom: ${z.brandMb}px; }
      .brand img { width: ${z.icon}px; height: ${z.icon}px; border-radius: ${z.radius}px; }
      .brand .name { font-size: ${z.name}px; font-weight: 650; letter-spacing: -0.5px; color: ${t.fg}; }
      h1 { font-size: ${z.h1}px; line-height: 1.25; font-weight: 600; letter-spacing: -0.3px; color: ${t.fg}; }
      .sub { margin-top: ${z.subTop}px; font-size: ${z.sub}px; line-height: 1.5; color: ${t.sub}; }
      .right { flex: none; width: ${popupW + 30}px; height: ${size.h}px; position: relative; }
      .popup {
        position: absolute; top: ${popupTop}px; left: 0; width: ${popupW}px;
        border-radius: 14px; overflow: hidden;
        border: ${t.border}; box-shadow: ${t.shadow}; background: ${t.popupBg};
      }
      .popup img { display: block; width: 100%; }
    </style></head><body>
      <div class="left">
        <div class="brand"><img src="${iconUri}" alt=""><span class="name">TrueTabs</span></div>
        <h1>${headline}</h1>
        ${sub ? `<p class="sub">${sub}</p>` : ""}
      </div>
      <div class="right"><div class="popup"><img src="${dataUri(popupFile)}" alt=""></div></div>
    </body></html>`,
    { waitUntil: "networkidle0" },
  );
  await sleep(250);
  await page.screenshot({ path: path.join(OUT_DIR, file) });
  await page.close();
  console.log(`wrote ${file}`);
}

for (const scheme of ["light", "dark"]) {
  const popupFile = await shotPopupRaw(scheme);
  await compose(scheme, popupFile, {
    size: CWS,
    scale: "screenshot",
    file: `store-popup-${scheme}.png`,
    headline: "The Arc-style tab butler for Chrome",
    sub: "No duplicate tabs. Stale tabs auto-archived, always undoable.<br>Grouped by site - or by topic, with AI that runs on your device.",
    popupW: 430,
    popupTop: 40,
  });
  if (scheme === "light") {
    await compose(scheme, popupFile, {
      size: TILE,
      scale: "tile",
      file: "store-tile-440x280.png",
      headline: "Tabs that keep themselves in order",
      sub: "",
      popupW: 168,
      popupTop: 26,
    });
    await compose(scheme, popupFile, {
      size: MARQUEE,
      scale: "marquee",
      file: "store-marquee-1400x560.png",
      headline: "Tabs that keep themselves in order",
      sub: "No duplicates. Stale tabs auto-archived, always undoable.<br>Grouped by site - or by topic, with AI that runs on your device.",
      popupW: 400,
      popupTop: 44,
    });
  }
  fs.unlinkSync(popupFile);
  await shot("options.html", `store-options-${scheme}.png`, { scheme });
  await shot("archive.html", `store-archive-${scheme}.png`, { scheme });
}

await browser.close();
server.close();
