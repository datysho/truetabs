// Build the GitHub social/hero images (1280x640 @2x, 2:1):
//   store/social-preview.png       - light (also the Settings -> Social preview upload)
//   store/social-preview-dark.png  - dark (README hero via <picture>)
// Left: icon, name, the promise (verbatim from the README - one promise, one
// place). Right: the real popup over a seeded world, top aligned, bottom
// bleeding off the frame - composed natively for the 2:1 crop so nothing
// important is ever cut. Sibling of truepin/test/shot-social.mjs.
// Run: cd test && node shot-social.mjs
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
const OUTDIR = process.argv[2] || path.resolve(__dirname, "../store");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataUri = (file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;

// The seed the picture is selling: real domains, so the groups carry the names
// a real browser would give them.
const TABS = [
  ["github.com", "Pull requests"],
  ["github.com", "Actions - all workflows"],
  ["youtube.com", "A talk on tab hygiene"],
  ["youtube.com", "Arc browser - a retrospective"],
  ["docs.google.com", "Quarterly plan"],
  ["news.ycombinator.com", "Tab hoarding thread"],
];

const THEMES = {
  light: {
    bg: "linear-gradient(135deg, #f7f9fc 0%, #eef3f9 55%, #e6edf6 100%)",
    name: "#1a1f27",
    h1: "#212835",
    sub: "#5b6472",
    shadow: "0 24px 64px rgba(20, 35, 60, 0.18), 0 4px 16px rgba(20, 35, 60, 0.10)",
    border: "none",
    popupBg: "#ffffff",
  },
  dark: {
    bg: "linear-gradient(135deg, #0f1319 0%, #151b24 55%, #1a222d 100%)",
    name: "#e8eaed",
    h1: "#dfe4ea",
    sub: "#98a2b0",
    shadow: "0 24px 64px rgba(0, 0, 0, 0.55), 0 4px 16px rgba(0, 0, 0, 0.35)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
    popupBg: "#292a2d",
  },
};

const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1)).replace(/[^\w -]/g, "") || "index";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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
    // Every hostname lands on the local server: real domains, zero network.
    `--host-resolver-rules=MAP * 127.0.0.1:${port}`,
  ],
});
const target = await browser.waitForTarget(
  (t) => t.type() === "service_worker" && t.url().endsWith("background.js"),
);
const worker = await target.worker();
const extId = new URL(target.url()).host;

await worker.evaluate(() => globalThis.__ttForceSettle());
async function setSettings(patch) {
  await worker.evaluate(async (p) => {
    const { settings } = await chrome.storage.sync.get("settings");
    await chrome.storage.sync.set({ settings: { ...(settings || {}), ...p } });
  }, patch);
}
await setSettings({ language: "en", theme: "light", autoGroup: "site", otherGroup: true });

for (const [host, title] of TABS) {
  await worker.evaluate(
    (u) => new Promise((r) => chrome.tabs.create({ url: u, active: false }, () => r())),
    `http://${host}/${encodeURIComponent(title)}`,
  );
}
await sleep(1800);
await worker.evaluate(() => globalThis.__ttUiCall({ type: "ui:organizeNow", scope: "all" }));
await sleep(600);

// A believable archive + today's counter: the numbers in the hero are the
// pitch, so they must not read as an empty install.
const day = 86400e3;
await worker.evaluate((entries) => globalThis.__ttSeedArchive(entries), [
  ["Chrome Extensions - developer guide", "developer.chrome.com", 0.2],
  ["Arc will archive your tabs - here's why", "arc.net", 0.4],
  ["Pricing - Linear", "linear.app", 0.6],
  ["The Verge - browser reviews", "theverge.com", 1.1],
  ["MDN - chrome.tabGroups API", "developer.mozilla.org", 1.3],
].map(([title, domain, age], i) => ({
  id: `social-${i}`,
  url: `https://${domain}/${i}`,
  title,
  favUrl: null,
  domain,
  groupTitle: null,
  groupColor: null,
  winHint: 1,
  archivedAt: Date.now() - age * day,
  batchId: `social-${Math.floor(age)}`,
  reason: "auto",
})));
await worker.evaluate(() => {
  const d = new Date(); // LOCAL date - the engine keys counters off local days
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  return chrome.storage.local.set({
    counters: { date, archivedToday: 12, dedupedToday: 7, sweptToday: 3 },
  });
});
await sleep(400);

// Readiness is observed, not slept for: a second popup open can race a
// suspending worker and render empty (ui:getState never resolves) - wait for
// real rows and reload once if they do not come.
async function shootPopup(theme) {
  await setSettings({ theme });
  const page = await browser.newPage();
  await page.setViewport({ width: 344, height: 760, deviceScaleFactor: 2 });
  await page.goto(`chrome-extension://${extId}/popup.html`);
  const ready = () =>
    page
      .waitForFunction(
        () =>
          document.body.classList.contains("ready") &&
          document.querySelectorAll(".group-row").length >= 2 &&
          document.getElementById("tabCount").textContent !== "-",
        { timeout: 5000 },
      )
      .then(() => true, () => false);
  if (!(await ready())) {
    await page.reload();
    if (!(await ready())) throw new Error(`popup (${theme}) never rendered its data`);
  }
  await sleep(300);
  const file = path.join(os.tmpdir(), `truetabs-social-popup-${theme}-${process.pid}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  return file;
}

// Compose the 2:1 frame. Images go in as data URIs: file:// subresources do
// not load inside setContent's about:blank context.
const iconUri = dataUri(path.join(EXTENSION_DIR, "icons", "tt-128.png"));
async function composeFrame(theme, popupFile, out) {
  const t = THEMES[theme];
  const compose = await browser.newPage();
  await compose.setViewport({ width: 1280, height: 640, deviceScaleFactor: 2 });
  await compose.setContent(
    `<!doctype html><html><head><style>
      * { margin: 0; box-sizing: border-box; }
      body {
        width: 1280px; height: 640px; overflow: hidden;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: ${t.bg};
        display: flex; align-items: center;
      }
      .left { flex: 1; padding: 0 64px 0 96px; }
      .brand { display: flex; align-items: center; gap: 20px; margin-bottom: 36px; }
      .brand img { width: 76px; height: 76px; border-radius: 16px; }
      .brand .name { font-size: 58px; font-weight: 650; letter-spacing: -0.5px; color: ${t.name}; }
      h1 { font-size: 40px; line-height: 1.2; font-weight: 600; letter-spacing: -0.3px; color: ${t.h1}; max-width: 560px; }
      .sub { margin-top: 22px; font-size: 21px; line-height: 1.5; color: ${t.sub}; max-width: 545px; }
      .right { flex: none; width: 460px; height: 640px; position: relative; }
      .popup {
        position: absolute; top: 56px; left: 0; width: 400px;
        border-radius: 16px; overflow: hidden;
        border: ${t.border};
        box-shadow: ${t.shadow};
        background: ${t.popupBg};
      }
      .popup img { display: block; width: 100%; }
    </style></head><body>
      <div class="left">
        <div class="brand">
          <img src="${iconUri}" alt="">
          <span class="name">TrueTabs</span>
        </div>
        <h1>The Arc-style tab butler for Chrome</h1>
        <p class="sub">No duplicate tabs. Stale tabs auto-archived, always undoable. Grouped by site - or by topic, with AI that runs on your device.</p>
      </div>
      <div class="right">
        <div class="popup"><img src="${dataUri(popupFile)}" alt=""></div>
      </div>
    </body></html>`,
    { waitUntil: "networkidle0" },
  );
  await sleep(300);
  await compose.screenshot({ path: out });
  await compose.close();
  console.log("saved", out);
}

for (const [theme, file] of [
  ["light", "social-preview.png"],
  ["dark", "social-preview-dark.png"],
]) {
  const popupFile = await shootPopup(theme);
  await composeFrame(theme, popupFile, path.join(OUTDIR, file));
  unlinkSync(popupFile);
}

await browser.close();
server.close();
process.exit(0);
