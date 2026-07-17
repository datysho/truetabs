// E2E suite for TrueTabs. Drives a real Chrome (for Testing) with the
// unpacked extension and verifies the behavior contracts:
//   dedup closes only fresh, user-shaped duplicate opens - never pinned;
//   stale tabs are archived (write-first), undoable, exclusions hold;
//   grouping touches only OUR groups, two strikes retire any fight;
//   breakers cap automation; the archive page and popup backends work.
//
// Deterministic time: automatic scans run through __ttTick({now}) with a
// clock override - no wall-clock waiting.
//
// Run: cd test && npm install && npm test   (HEADFUL=1 npm test to watch)

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
// A real file:// page: duplicates of local pages are duplicates too.
const filePagePath = path.join(os.tmpdir(), "truetabs-e2e-page.html");
const TEST_TIMEOUT_MS = 60_000;
const GLOBAL_TIMEOUT_MS = 480_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- harness
let browser;
let baseUrl; // http://127.0.0.1:port
let altUrl; // http://localhost:port - a second "site" for cross-domain tests
let currentStep = "";
const results = [];

const step = (label) => {
  currentStep = label;
};

function assert(condition, label) {
  if (!condition) throw new Error(`assert failed: ${label}`);
}

// ONLY="substring" npm test - run a single contract while chasing it.
const ONLY = process.env.ONLY || "";

async function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  currentStep = "(start)";
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`test timed out at step: ${currentStep}`)),
      TEST_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([fn(), timeout]);
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error(`FAIL  ${name}\n      ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(label, probe, timeoutMs = 8000, intervalMs = 150) {
  step(`waitFor ${label}`);
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(intervalMs);
  }
}

let cachedWorker = null;

async function findSwTarget() {
  return browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().endsWith("background.js"),
    { timeout: 20_000 },
  );
}

async function getWorker() {
  if (cachedWorker) return cachedWorker;
  const target = await findSwTarget();
  cachedWorker = await Promise.race([
    target.worker(),
    sleep(5000).then(() => {
      throw new Error("worker attach timed out");
    }),
  ]);
  return cachedWorker;
}

async function swEval(fn, ...args) {
  for (let attempt = 0; ; attempt++) {
    try {
      const worker = await getWorker();
      return await Promise.race([
        worker.evaluate(fn, ...args),
        sleep(15_000).then(() => {
          throw new Error("swEval timed out");
        }),
      ]);
    } catch (err) {
      cachedWorker = null; // worker may have been suspended; re-attach
      if (attempt >= 1) throw new Error(`swEval failed at "${currentStep}": ${err.message}`);
      await sleep(300);
    }
  }
}

const ui = (request) => swEval((r) => globalThis.__ttUiCall(r), request);

const forceSettle = () => swEval(() => globalThis.__ttForceSettle());

const createTab = (props) =>
  swEval(
    (p) =>
      new Promise((resolve) =>
        chrome.tabs.create(p, (tab) => {
          void chrome.runtime.lastError;
          resolve(tab ? { id: tab.id, windowId: tab.windowId } : null);
        }),
      ),
    props,
  );

const getTab = (tabId) =>
  swEval(
    (id) =>
      new Promise((resolve) =>
        chrome.tabs.get(id, (tab) => {
          void chrome.runtime.lastError;
          resolve(
            tab
              ? {
                  id: tab.id,
                  url: tab.url || tab.pendingUrl || "",
                  pinned: tab.pinned,
                  active: tab.active,
                  windowId: tab.windowId,
                  groupId: tab.groupId,
                }
              : null,
          );
        }),
      ),
    tabId,
  );

const queryTabs = (query = {}) =>
  swEval(
    (q) =>
      chrome.tabs
        .query(q)
        .then((tabs) =>
          tabs.map((t) => ({
            id: t.id,
            url: t.url || t.pendingUrl || "",
            pinned: t.pinned,
            active: t.active,
            windowId: t.windowId,
            groupId: t.groupId,
          })),
        ),
    query,
  );

const countTabsWith = async (marker) =>
  (await queryTabs()).filter((t) => t.url.includes(marker)).length;

// Open a content tab the way a user-shaped navigation lands: create blank
// (the blank commit does not spend freshness), then navigate. Chrome commits
// API navigations as "link" - the classifier sees them exactly like a user
// link click, so the REAL dedup/grouping path runs, no simulation needed.
async function openViaCommit(url, { windowId, active = true } = {}) {
  const tab = await createTab({ url: "about:blank", windowId, active });
  await swEval(
    (tabId, u) =>
      new Promise((resolve) =>
        chrome.tabs.update(tabId, { url: u }, () => {
          void chrome.runtime.lastError;
          resolve();
        }),
      ),
    tab.id,
    url,
  );
  await waitFor(`tab ${tab.id} at ${url}`, async () => {
    const t = await getTab(tab.id);
    return t === null ? { gone: true } : t.url === url ? t : null;
  });
  await sleep(150); // let the commit job drain through the queue
  return tab;
}

// Between tests: close every http(s) tab and clear per-session engine state
// (NOT the settle flag) so each test builds its own world.
async function resetWorld() {
  await swEval(async () => {
    // Keep the browser alive: a sweep may have closed the initial blank tab,
    // and emptying the last window would take the whole window down.
    const wins = (await chrome.windows.getAll({ windowTypes: ["normal"] })).filter(
      (w) => !w.incognito,
    );
    if (!wins.length) {
      await new Promise((r) => chrome.windows.create({ url: "about:blank" }, () => r()));
    } else {
      await new Promise((r) =>
        chrome.tabs.create({ url: "about:blank", windowId: wins[0].id, active: false }, () => {
          void chrome.runtime.lastError;
          r();
        }),
      );
    }
    const tabs = await chrome.tabs.query({});
    const blanks = tabs.filter((t) => !/^https?:/.test(t.url || t.pendingUrl || ""));
    const victims = [
      ...tabs.filter((t) => /^https?:/.test(t.url || t.pendingUrl || "")),
      ...blanks.slice(1), // keep exactly one blank per run - a clean world
    ];
    for (const t of victims) {
      if (t.pinned) {
        await new Promise((r) => chrome.tabs.update(t.id, { pinned: false }, () => r()));
      }
      await new Promise((r) =>
        chrome.tabs.remove(t.id, () => {
          void chrome.runtime.lastError;
          r();
        }),
      );
    }
    await chrome.storage.session.remove([
      "strikes",
      "dedupRecent",
      "ourGroups",
      "selfOps",
      "selfClosed",
      "closeLedger",
      "createLedger",
      "closeAllowance",
      "createAllowance",
      "pausedUntil",
      "breakerNotifiedAt",
    ]);
    await chrome.storage.local.remove(["ourGroupSigs", "lastBatch", "counters"]);
    const { archive } = await chrome.storage.local.get("archive");
    if (archive) {
      archive.entries = [];
      await chrome.storage.local.set({ archive });
    }
  });
  await forceSettle();
  await sleep(200);
}

const tabState = (tabId) =>
  swEval(async (key) => (await chrome.storage.session.get(key))[key] ?? null, `t${tabId}`);

const archiveEntries = () =>
  swEval(async () => {
    const { archive } = await chrome.storage.local.get("archive");
    return archive ? archive.entries : [];
  });

// ----------------------------------------------------------------- server
function startServer() {
  const server = http.createServer((req, res) => {
    const name = req.url.replace(/\W/g, "") || "index";
    const respond = () => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><title>page-${name}</title></head>` +
          `<body style="height:100vh;margin:0">page ${name}</body></html>`,
      );
    };
    // /slow* pages take 1.5s to respond: lets tests prove that pre-commit
    // dedup acts BEFORE the page load, not after it.
    if (req.url.startsWith("/slow")) setTimeout(respond, 1500);
    else respond();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ------------------------------------------------------------------ tests
async function main() {
  fs.writeFileSync(
    filePagePath,
    "<!doctype html><html><head><title>page-localFile</title></head><body>local</body></html>",
  );
  const server = await startServer();
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  altUrl = `http://localhost:${port}`;

  browser = await puppeteer.launch({
    headless: !process.env.HEADFUL,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  const globalWatchdog = setTimeout(() => {
    console.error("GLOBAL TIMEOUT - aborting");
    process.exit(2);
  }, GLOBAL_TIMEOUT_MS);

  // Collect service worker errors for the whole run.
  const swErrors = [];
  {
    const swTarget = await findSwTarget();
    const session = await swTarget.createCDPSession();
    await session.send("Runtime.enable");
    await session.send("Log.enable");
    session.on("Log.entryAdded", (event) => {
      const text = event.entry?.text || "";
      if (/Unchecked runtime\.lastError|Uncaught \(in promise\)/.test(text)) {
        swErrors.push(text);
      }
    });
    session.on("Runtime.exceptionThrown", (event) => {
      const text =
        event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || "";
      swErrors.push(`exception: ${text.split("\n")[0]}`);
    });
  }

  await test("boot: defaults, alarm registered, settle passes", async () => {
    step("read state");
    const state = await ui({ type: "ui:getState" });
    assert(state.settings.dedupAuto === true, "dedupAuto default on");
    assert(state.settings.dedupScope === "window", "dedupScope default window");
    assert(state.settings.archiveAfter === "24h", "archiveAfter default 24h");
    assert(state.settings.autoGroup === "site", "autoGroup default site");
    assert(state.settings.smartEngine === "off", "smart off by default");
    assert(state.settings.sortGroups === "off" && state.settings.sortTabs === "off", "sort off by default");
    step("alarm");
    const alarm = await swEval(
      () => new Promise((resolve) => chrome.alarms.get("tt-tick", (a) => resolve(a || null))),
    );
    assert(alarm && alarm.periodInMinutes === 1, "tt-tick alarm registered");
    step("settle");
    await waitFor("settled", async () => (await ui({ type: "ui:getState" })).settled);
  });

  await test("url identity: tracking params, slash, case, ?v=, spa hash", async () => {
    const norm = (u) => swEval((x) => globalThis.__ttNormalizeUrl(x), u);
    assert(
      (await norm("https://Ex.COM/a/?utm_source=x&b=2")) === (await norm("https://ex.com/a?b=2")),
      "utm stripped, slash+case folded",
    );
    assert(
      (await norm("https://youtube.com/watch?v=1")) !== (await norm("https://youtube.com/watch?v=2")),
      "?v= significant",
    );
    assert(
      (await norm("https://ex.com/a#section")) === (await norm("https://ex.com/a")),
      "anchor hash stripped",
    );
    assert(
      (await norm("https://ex.com/a#/route")) !== (await norm("https://ex.com/a#/other")),
      "spa hash kept",
    );
    assert((await norm("chrome://settings")) === null, "chrome:// never participates");
    assert(
      (await norm("https://ex.com/a?b=2&a=1")) === (await norm("https://ex.com/a?a=1&b=2")),
      "query order folded",
    );
  });

  await test("classifier: redirects, form posts, reloads, back/forward, subframes ignored", async () => {
    const classify = (details) => swEval((d) => globalThis.__ttClassifyCommit(d), details);
    const base = { frameId: 0, transitionQualifiers: [] };
    assert((await classify({ ...base, transitionType: "link" })) === "link", "link");
    assert((await classify({ ...base, transitionType: "typed" })) === "address", "typed");
    assert(
      (await classify({ ...base, transitionType: "auto_bookmark" })) === "bookmark",
      "bookmark",
    );
    assert(
      (await classify({ ...base, transitionType: "link", transitionQualifiers: ["server_redirect"] })) ===
        null,
      "server redirect ignored",
    );
    assert(
      (await classify({ ...base, transitionType: "link", transitionQualifiers: ["client_redirect"] })) ===
        null,
      "client redirect ignored",
    );
    assert((await classify({ ...base, transitionType: "form_submit" })) === null, "form post");
    assert((await classify({ ...base, transitionType: "reload" })) === null, "reload");
    assert(
      (await classify({ ...base, transitionType: "link", transitionQualifiers: ["forward_back"] })) ===
        null,
      "back/forward",
    );
    assert(
      (await classify({ ...base, frameId: 1, transitionType: "link" })) === null,
      "subframe",
    );
    assert(
      (await classify({ ...base, transitionType: "auto_toplevel" })) === null,
      "extension-created tabs (auto_toplevel) never dedup",
    );
  });

  await test("dedup: duplicate open closes itself, survivor focused (same window)", async () => {
    await resetWorld();
    const first = await openViaCommit(`${baseUrl}/dupA`, { active: false });
    const dupe = await openViaCommit(`${baseUrl}/dupA`, { active: true });
    await waitFor("duplicate closed", async () => (await getTab(dupe.id)) === null);
    const survivor = await getTab(first.id);
    assert(survivor, "survivor alive");
    await waitFor("survivor focused", async () => (await getTab(first.id)).active);
    const state = await ui({ type: "ui:getState" });
    assert(state.counts.dedupedToday >= 1, "counter bumped");
  });

  await test("dedup: background duplicate closes silently, no focus steal", async () => {
    await resetWorld();
    const anchor = await openViaCommit(`${baseUrl}/dupBg`, { active: false });
    const focus = await openViaCommit(`${baseUrl}/focusHolder`, { active: true });
    const dupe = await openViaCommit(`${baseUrl}/dupBg`, { active: false });
    await waitFor("bg duplicate closed", async () => (await getTab(dupe.id)) === null);
    assert((await getTab(anchor.id)) !== null, "anchor alive");
    assert((await getTab(focus.id)).active, "focus unchanged");
  });

  await test("dedup: pinned may be the focus target but NEVER the victim", async () => {
    await resetWorld();
    const pinnedTab = await openViaCommit(`${baseUrl}/pinnedPage`, { active: false });
    await swEval(
      (id) => new Promise((r) => chrome.tabs.update(id, { pinned: true }, () => r())),
      pinnedTab.id,
    );
    // new duplicate of the pinned page: the new tab closes, pinned survives
    const dupe = await openViaCommit(`${baseUrl}/pinnedPage`, { active: true });
    await waitFor("dupe of pinned closed", async () => (await getTab(dupe.id)) === null);
    assert((await getTab(pinnedTab.id)).pinned, "pinned survivor alive");
    // a PINNED tab is never a victim: pin a blank tab FIRST, then navigate it
    // onto a page that already exists elsewhere - it must stay open.
    const second = await openViaCommit(`${baseUrl}/pinnedPage2`, { active: false });
    const prePinned = await createTab({ url: "about:blank", active: false });
    await swEval(
      (id) => new Promise((r) => chrome.tabs.update(id, { pinned: true }, () => r())),
      prePinned.id,
    );
    await swEval(
      (tabId, u) =>
        new Promise((resolve) =>
          chrome.tabs.update(tabId, { url: u }, () => {
            void chrome.runtime.lastError;
            resolve();
          }),
        ),
      prePinned.id,
      `${baseUrl}/pinnedPage2`,
    );
    await sleep(700);
    assert((await getTab(prePinned.id)) !== null, "pinned copy never closed");
    assert((await getTab(second.id)) !== null, "regular copy untouched");
  });

  await test("dedup: existing tab navigating to a duplicate keeps its history", async () => {
    await resetWorld();
    const target = await openViaCommit(`${baseUrl}/navTarget`, { active: false });
    const traveler = await openViaCommit(`${baseUrl}/navStart`, { active: false });
    // second real commit on the same tab: not fresh anymore, never a victim
    await swEval(
      (tabId, u) =>
        new Promise((resolve) =>
          chrome.tabs.update(tabId, { url: u }, () => {
            void chrome.runtime.lastError;
            resolve();
          }),
        ),
      traveler.id,
      `${baseUrl}/navTarget`,
    );
    await sleep(700);
    assert((await getTab(traveler.id)) !== null, "traveler alive (back-stack preserved)");
    assert((await getTab(target.id)) !== null, "target alive");
  });

  await test("dedup: two strikes retire the key for the session", async () => {
    await resetWorld();
    const url = `${baseUrl}/strikeMe`;
    const keeper = await openViaCommit(url, { active: false });
    const closedOnce = await openViaCommit(url, { active: false });
    await waitFor("strike1 closed", async () => (await getTab(closedOnce.id)) === null);
    const closedTwice = await openViaCommit(url, { active: false }); // reopen = strike 1
    await waitFor("strike2 closed", async () => (await getTab(closedTwice.id)) === null);
    const survivorNow = await openViaCommit(url, { active: false }); // reopen = strike 2
    await sleep(700);
    assert((await getTab(survivorNow.id)) !== null, "third reopen survives - key retired");
    const diag = await ui({ type: "ui:diagnostics" });
    const struck = Object.keys(diag.strikes).find((k) => k.startsWith("dedup:") && k.includes("strikeMe"));
    assert(struck && diag.strikes[struck].count >= 2, "strike ledger shows 2");
    assert((await getTab(keeper.id)) !== null, "keeper alive");
  });

  await test("dedup: settle gate blocks automation before settled", async () => {
    await resetWorld();
    await swEval(() => chrome.storage.session.set({ settled: false }));
    const a = await openViaCommit(`${baseUrl}/gated`, { active: false });
    const b = await openViaCommit(`${baseUrl}/gated`, { active: false });
    await sleep(700);
    assert((await getTab(a.id)) !== null && (await getTab(b.id)) !== null, "both alive: gate closed");
    await forceSettle();
  });

  await test("sweep duplicates: closes n-1 per bucket, victims archived as dupe-sweep", async () => {
    await resetWorld();
    const url = `${baseUrl}/sweepPage`;
    // build the duplicate pile with auto-dedup OFF (sweep must do the work)
    await ui({ type: "ui:setSetting", key: "dedupAuto", value: false });
    const t1 = await openViaCommit(url, { active: false });
    const t2 = await openViaCommit(url, { active: false });
    const t3 = await openViaCommit(url, { active: false });
    await ui({ type: "ui:setSetting", key: "dedupAuto", value: true });
    assert((await countTabsWith("/sweepPage")) === 3, "three copies built");
    const result = await ui({ type: "ui:sweepDupes", scope: "all" });
    assert(result.closed >= 2, `sweep closed ${result.closed} >= 2`);
    await waitFor("one copy left", async () => (await countTabsWith("/sweepPage")) === 1);
    const entries = await archiveEntries();
    const swept = entries.filter((e) => e.reason === "dupe-sweep" && e.url.includes("/sweepPage"));
    assert(swept.length === 2, "sweep victims landed in archive");
  });

  await test("sweep: surplus empty new-tab pages close too (not archived)", async () => {
    await resetWorld();
    const anchor = await openViaCommit(`${baseUrl}/blankAnchor`, { active: true });
    const b1 = await createTab({ url: "about:blank", active: false });
    const b2 = await createTab({ url: "about:blank", active: false });
    const b3 = await createTab({ url: "about:blank", active: false });
    await sleep(300);
    const before = await ui({ type: "ui:getState" });
    assert(before.counts.dupes >= 3, `blank surplus counted (${before.counts.dupes})`);
    const result = await ui({ type: "ui:sweepDupes", scope: "all" });
    assert(result.closed >= 3, `blanks closed (${result.closed})`);
    assert((await getTab(b1.id)) === null && (await getTab(b2.id)) === null, "blanks gone");
    assert((await getTab(anchor.id)) !== null, "content tab untouched");
    const entries = await archiveEntries();
    assert(!entries.some((e) => e.url.startsWith("about:")), "blanks never archived");
  });

  await test("archive: stale tab archived with url/title/winHint, closed, undoable state set", async () => {
    await resetWorld();
    const stale = await openViaCommit(`${baseUrl}/staleOne`, { active: false});
    const fresh = await openViaCommit(`${baseUrl}/freshOne`, { active: false});
    // freshen "fresh" by touching it at future-25h minus a minute; the stale
    // one keeps its real lastAccessed (now).
    const future = Date.now() + 25 * 3600e3;
    await swEval(
      (id) => new Promise((r) => chrome.tabs.update(id, { active: true }, () => r())),
      fresh.id,
    );
    // fresh is ACTIVE (excluded anyway); stale is idle and 25h old at `future`
    await swEval((n) => globalThis.__ttTick({ now: n }), future);
    try {
      await waitFor("stale closed", async () => (await getTab(stale.id)) === null);
    } catch (err) {
      const dump = await swEval(async () => ({
        trace: globalThis.__ttDiag.trace,
        last: globalThis.__ttDiag.last,
        session: await chrome.storage.session.get([
          "pausedUntil",
          "closeLedger",
          "closeAllowance",
          "ourGroups",
          "strikes",
        ]),
        tabs: (await chrome.tabs.query({})).map((t) => ({
          id: t.id,
          url: (t.url || "").slice(-32),
          active: t.active,
          groupId: t.groupId,
          lastAccessed: t.lastAccessed,
        })),
      }));
      throw new Error(`${err.message}\nDUMP: ${JSON.stringify(dump)}`);
    }
    assert((await getTab(fresh.id)) !== null, "fresh alive");
    const entries = await archiveEntries();
    const entry = entries.find((e) => e.url.includes("/staleOne"));
    assert(entry, "archive entry exists");
    assert(entry.title.includes("page-staleOne"), "title captured");
    assert(entry.winHint === stale.windowId, "window hint captured");
    assert(entry.reason === "auto", "reason auto");
    const { lastBatch } = await swEval(() => chrome.storage.local.get("lastBatch"));
    assert(lastBatch && lastBatch.batchId === entry.batchId, "lastBatch points at the batch");
  });

  await test("archive: exclusions hold - pinned, active, allowlisted, foreign group", async () => {
    await resetWorld();
    const future = Date.now() + 25 * 3600e3;
    const pinnedTab = await openViaCommit(`${baseUrl}/exclPinned`, { active: false});
    await swEval((id) => chrome.tabs.update(id, { pinned: true }), pinnedTab.id);
    const activeTab = await openViaCommit(`${baseUrl}/exclActive`, { active: true});
    const allowed = await openViaCommit(`${altUrl}/exclAllowed`, { active: false});
    await ui({ type: "ui:setSetting", key: "archiveAllowlist", value: ["localhost"] });
    const foreign = await openViaCommit(`${baseUrl}/exclForeign`, { active: false});
    const foreignPeer = await openViaCommit(`${baseUrl}/exclForeignPeer`, {
      active: false,
      kind: "address",
    });
    // a group made outside our engine = foreign (no registry record)
    await swEval(
      (ids) => chrome.tabs.group({ tabIds: ids }),
      [foreign.id, foreignPeer.id],
    );
    await sleep(300);
    await swEval((n) => globalThis.__ttTick({ now: n }), future);
    await sleep(600);
    assert((await getTab(pinnedTab.id)) !== null, "pinned never archived");
    assert((await getTab(activeTab.id)) !== null, "active never archived");
    assert((await getTab(allowed.id)) !== null, "allowlisted never archived");
    assert((await getTab(foreign.id)) !== null, "foreign group member skipped");
    assert((await getTab(foreignPeer.id)) !== null, "foreign group member skipped 2");
    await ui({
      type: "ui:setSetting",
      key: "archiveAllowlist",
      value: ["meet.google.com", "zoom.us", "teams.microsoft.com"],
    });
  });

  await test("archive: undo restores the batch into the original window, entries removed", async () => {
    await resetWorld();
    const s1 = await openViaCommit(`${baseUrl}/undoA`, { active: false});
    const s2 = await openViaCommit(`${baseUrl}/undoB`, { active: false});
    const future = Date.now() + 25 * 3600e3;
    await swEval((n) => globalThis.__ttTick({ now: n }), future);
    await waitFor("both archived", async () => !(await getTab(s1.id)) && !(await getTab(s2.id)));
    const result = await ui({ type: "ui:undoLastBatch" });
    assert(result.restored >= 2, `undo restored ${result.restored} >= 2`);
    await waitFor("undoA back", async () => (await countTabsWith("/undoA")) === 1);
    await waitFor("undoB back", async () => (await countTabsWith("/undoB")) === 1);
    const entries = await archiveEntries();
    assert(
      !entries.some((e) => e.url.includes("/undoA") || e.url.includes("/undoB")),
      "restored entries removed from archive",
    );
    const back = (await queryTabs()).find((t) => t.url.includes("/undoA"));
    assert(back.windowId === s1.windowId, "restored into original window");
  });

  await test("archive: FIFO cap and TTL prune", async () => {
    const seed = [];
    for (let i = 0; i < 30; i++) {
      seed.push({
        id: `seed-${i}`,
        url: `https://seed.example/${i}`,
        title: `seed ${i}`,
        favUrl: null,
        domain: "seed.example",
        groupTitle: null,
        groupColor: null,
        winHint: 1,
        archivedAt: Date.now() - i * 1000,
        batchId: "seedbatch",
        reason: "auto",
      });
    }
    // TTL: three entries far older than 30d
    for (let i = 0; i < 3; i++) {
      seed.push({
        id: `old-${i}`,
        url: `https://old.example/${i}`,
        title: `old ${i}`,
        favUrl: null,
        domain: "old.example",
        groupTitle: null,
        groupColor: null,
        winHint: 1,
        archivedAt: Date.now() - 40 * 86400e3,
        batchId: "oldbatch",
        reason: "auto",
      });
    }
    await swEval((entries) => globalThis.__ttSeedArchive(entries), seed);
    const listed = await ui({ type: "ui:archive:list" }); // lazy TTL prune runs here
    assert(
      !listed.entries.some((e) => e.id.startsWith("old-")),
      "40d-old entries pruned at list",
    );
    assert(listed.entries.some((e) => e.id === "seed-0"), "fresh seeds kept");
    // cap: seed beyond 5000 and verify the tail is dropped
    const bulk = [];
    for (let i = 0; i < 5100; i++) {
      bulk.push({
        id: `bulk-${i}`,
        url: `https://bulk.example/${i}`,
        title: `bulk ${i}`,
        favUrl: null,
        domain: "bulk.example",
        groupTitle: null,
        groupColor: null,
        winHint: 1,
        archivedAt: Date.now(),
        batchId: "bulkbatch",
        reason: "auto",
      });
    }
    await swEval((entries) => globalThis.__ttSeedArchive(entries), bulk);
    const after = await archiveEntries();
    assert(after.length <= 5000, `cap holds: ${after.length} <= 5000`);
    await ui({ type: "ui:archive:clear", scope: "all" });
  });

  await test("archive page backend: list, restore, delete", async () => {
    await resetWorld();
    const gone = await openViaCommit(`${baseUrl}/pageRestore`, { active: false});
    const future = Date.now() + 25 * 3600e3;
    await swEval((n) => globalThis.__ttTick({ now: n }), future);
    await waitFor("archived", async () => (await getTab(gone.id)) === null);
    const listed = await ui({ type: "ui:archive:list" });
    const entry = listed.entries.find((e) => e.url.includes("/pageRestore"));
    assert(entry, "listed");
    const restored = await ui({ type: "ui:archive:restore", ids: [entry.id] });
    assert(restored.restored === 1, "restored one");
    await waitFor("tab back", async () => (await countTabsWith("/pageRestore")) === 1);
    const again = await ui({ type: "ui:archive:list" });
    assert(!again.entries.some((e) => e.id === entry.id), "entry removed after restore");
    // delete path
    const del = await openViaCommit(`${baseUrl}/pageDelete`, { active: false});
    await swEval((n) => globalThis.__ttTick({ now: n }), future);
    await waitFor("archived 2", async () => (await getTab(del.id)) === null);
    const listed2 = await ui({ type: "ui:archive:list" });
    const entry2 = listed2.entries.find((e) => e.url.includes("/pageDelete"));
    const deleted = await ui({ type: "ui:archive:delete", ids: [entry2.id] });
    assert(deleted.deleted === 1, "deleted one");
  });

  await test("groups: second same-site tab mints the group; singleton stays loose", async () => {
    await resetWorld();
    const solo = await openViaCommit(`${altUrl}/gSolo`, { active: false });
    await sleep(500);
    assert((await getTab(solo.id)).groupId === -1, "singleton ungrouped");
    const peer = await openViaCommit(`${altUrl}/gPeer`, { active: false });
    await waitFor("group minted", async () => (await getTab(peer.id)).groupId !== -1);
    const soloNow = await getTab(solo.id);
    const peerNow = await getTab(peer.id);
    assert(soloNow.groupId === peerNow.groupId, "both in one group");
    const group = await swEval((gid) => chrome.tabGroups.get(gid), peerNow.groupId);
    assert(group.title === "Localhost", `clean title (got "${group.title}")`);
    const diag = await ui({ type: "ui:diagnostics" });
    assert(diag.ourGroups[String(peerNow.groupId)], "registered as ours");
  });

  await test("groups: third tab joins; other site gets its own group; pinned never grouped", async () => {
    const third = await openViaCommit(`${altUrl}/gThird`, { active: false });
    await waitFor("third joined", async () => (await getTab(third.id)).groupId !== -1);
    const other = await openViaCommit(`${baseUrl}/gOtherA`, { active: false });
    const otherPeer = await openViaCommit(`${baseUrl}/gOtherB`, { active: false });
    await waitFor("second group", async () => (await getTab(otherPeer.id)).groupId !== -1);
    assert(
      (await getTab(other.id)).groupId === (await getTab(otherPeer.id)).groupId,
      "same second group",
    );
    assert(
      (await getTab(third.id)).groupId !== (await getTab(otherPeer.id)).groupId,
      "different groups per site",
    );
    const pinnedTab = await openViaCommit(`${altUrl}/gPinned`, { active: false });
    await swEval((id) => chrome.tabs.update(id, { pinned: true }), pinnedTab.id);
    await swEval(
      (tabId, u) =>
        globalThis.__ttSimulateCommit({
          tabId,
          url: u,
          transitionType: "link",
          transitionQualifiers: [],
        }),
      pinnedTab.id,
      `${altUrl}/gPinned`,
    );
    await sleep(500);
    assert((await getTab(pinnedTab.id)).groupId === -1, "pinned never grouped");
  });

  await test("groups: foreign group untouched by organize now and continuous mode", async () => {
    await resetWorld();
    const f1 = await createTab({ url: `${baseUrl}/foreignKeep1` });
    const f2 = await createTab({ url: `${baseUrl}/foreignKeep2` });
    await sleep(300);
    const foreignGid = await swEval((ids) => chrome.tabs.group({ tabIds: ids }), [f1.id, f2.id]);
    await swEval((gid) => chrome.tabGroups.update(gid, { title: "MINE", color: "red" }), foreignGid);
    await sleep(300);
    await ui({ type: "ui:organizeNow", scope: "all" });
    await sleep(500);
    const g = await swEval((gid) => chrome.tabGroups.get(gid), foreignGid);
    assert(g.title === "MINE" && g.color === "red", "foreign group untouched");
    assert((await getTab(f1.id)).groupId === foreignGid, "members stay");
    const diag = await ui({ type: "ui:diagnostics" });
    assert(!diag.ourGroups[String(foreignGid)], "never adopted");
  });

  await test("groups: user pull-out respected; rename of our group disowns it", async () => {
    await resetWorld();
    const a = await openViaCommit(`${altUrl}/pull1`, { active: false });
    const b = await openViaCommit(`${altUrl}/pull2`, { active: false });
    await waitFor("grouped", async () => (await getTab(b.id)).groupId !== -1);
    const gid = (await getTab(b.id)).groupId;
    // user pulls b out
    await swEval((id) => chrome.tabs.ungroup(id), b.id);
    await waitFor("ungrouped", async () => (await getTab(b.id)).groupId === -1);
    await sleep(400);
    // next commit on b must NOT regroup it
    await swEval(
      (tabId, u) =>
        globalThis.__ttSimulateCommit({
          tabId,
          url: u,
          transitionType: "link",
          transitionQualifiers: [],
        }),
      b.id,
      `${altUrl}/pull2`,
    );
    await sleep(500);
    assert((await getTab(b.id)).groupId === -1, "pulled-out tab left alone");
    // user renames our group -> disowned
    await swEval((g) => chrome.tabGroups.update(g, { title: "Custom" }), gid);
    await sleep(400);
    const diag = await ui({ type: "ui:diagnostics" });
    assert(!diag.ourGroups[String(gid)], "renamed group disowned");
  });

  await test("collapse: idle our-group collapses on tick; user expand strikes; twice retires", async () => {
    await resetWorld();
    const a = await openViaCommit(`${baseUrl}/colA`, { active: false });
    const b = await openViaCommit(`${baseUrl}/colB`, { active: false });
    await waitFor("grouped", async () => (await getTab(b.id)).groupId !== -1);
    const gid = (await getTab(b.id)).groupId;
    // keep another tab active so members are not active
    await openViaCommit(`${altUrl}/colFocus`, { active: true});
    const future = Date.now() + 11 * 60e3; // > 10m collapse threshold, < archive
    await swEval((n) => globalThis.__ttTick({ now: n }), future);
    await waitFor("collapsed", async () => (await swEval((g) => chrome.tabGroups.get(g), gid)).collapsed);
    // user expands: strike 1, touch
    await swEval((g) => chrome.tabGroups.update(g, { collapsed: false }), gid);
    await sleep(400);
    const future2 = future + 12 * 60e3;
    await swEval((n) => globalThis.__ttTick({ now: n }), future2);
    await waitFor(
      "collapsed again",
      async () => (await swEval((g) => chrome.tabGroups.get(g), gid)).collapsed,
    );
    await swEval((g) => chrome.tabGroups.update(g, { collapsed: false }), gid);
    await sleep(400);
    const future3 = future2 + 12 * 60e3;
    await swEval((n) => globalThis.__ttTick({ now: n }), future3);
    await sleep(700);
    const group = await swEval((g) => chrome.tabGroups.get(g), gid);
    assert(group.collapsed === false, "second expand retired collapsing (two strikes)");
  });

  await test("merge windows: loose tabs and whole groups move; pinned stay behind", async () => {
    await resetWorld();
    const current = (await queryTabs({ active: true }))[0].windowId;
    const newWin = await swEval(
      () =>
        new Promise((resolve) =>
          chrome.windows.create({ url: "about:blank" }, (w) => resolve({ id: w.id })),
        ),
    );
    await sleep(300);
    const loose = await createTab({ url: `${baseUrl}/mergeLoose`, windowId: newWin.id });
    const g1 = await createTab({ url: `${baseUrl}/mergeG1`, windowId: newWin.id });
    const g2 = await createTab({ url: `${baseUrl}/mergeG2`, windowId: newWin.id });
    const gid = await swEval((ids) => chrome.tabs.group({ tabIds: ids }), [g1.id, g2.id]);
    await swEval((g) => chrome.tabGroups.update(g, { title: "KeepMe", color: "purple" }), gid);
    const pinnedStay = await createTab({ url: `${baseUrl}/mergePinned`, windowId: newWin.id });
    await swEval((id) => chrome.tabs.update(id, { pinned: true }), pinnedStay.id);
    await sleep(400);
    const result = await ui({ type: "ui:mergeWindows", targetWindowId: current });
    assert(result.moved >= 3, `moved ${result.moved} >= 3`);
    assert(result.groupsMoved === 1, "one group moved");
    await waitFor("loose moved", async () => (await getTab(loose.id)).windowId === current);
    const movedG1 = await getTab(g1.id);
    assert(movedG1.windowId === current, "grouped tab moved");
    const group = await swEval((g) => chrome.tabGroups.get(g), movedG1.groupId);
    assert(group.title === "KeepMe" && group.color === "purple", "group identity preserved");
    const pinnedNow = await getTab(pinnedStay.id);
    assert(pinnedNow.windowId === newWin.id, "pinned stayed in its window");
    assert(result.pinnedLeft >= 1, "reported pinned left behind");
    // cleanup: unpin and close the leftover window
    await swEval((id) => chrome.tabs.update(id, { pinned: false }), pinnedStay.id);
    await swEval((id) => new Promise((r) => chrome.windows.remove(id, () => r())), newWin.id);
  });

  await test("circuit breaker: close storm capped, automation pauses, single notification", async () => {
    await resetWorld();
    // stuff the ledger to the brim, then ask for two more closes
    await swEval((burst) => {
      const ledger = [];
      for (let i = 0; i < burst; i++) ledger.push(Date.now());
      return chrome.storage.session.set({ closeLedger: ledger, closeAllowance: 0 });
    }, 25);
    const v1 = await openViaCommit(`${baseUrl}/breakerA`, { active: false });
    const v2 = await openViaCommit(`${baseUrl}/breakerA`, { active: false });
    await sleep(700);
    assert((await getTab(v2.id)) !== null, "close refused by breaker");
    const state = await ui({ type: "ui:getState" });
    assert(state.paused === true, "automation paused");
    // unpause + clear ledger for the rest of the suite
    await swEval(() =>
      chrome.storage.session.set({ pausedUntil: 0, closeLedger: [], breakerNotifiedAt: 0 }),
    );
  });

  await test("smart: mock AI organizes by topic; garbage falls back to domains", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "builtin" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "off" });
    const t1 = await createTab({ url: `${baseUrl}/topicCats` });
    const t2 = await createTab({ url: `${altUrl}/topicCatCare` });
    await sleep(400);
    await swEval(() =>
      globalThis.__ttSetMockAi({
        availability: "available",
        respond: () => JSON.stringify({ groups: [{ name: "Cats", tabIndices: [0, 1] }] }),
      }),
    );
    const result = await ui({ type: "ui:smartOrganize", scope: "all" });
    assert(result.groupsCreated >= 1, "smart group created");
    const t1Now = await getTab(t1.id);
    const t2Now = await getTab(t2.id);
    assert(t1Now.groupId !== -1 && t1Now.groupId === t2Now.groupId, "both in the topic group");
    const group = await swEval((g) => chrome.tabGroups.get(g), t1Now.groupId);
    assert(group.title === "Cats", "topic title applied");
    // garbage response -> domain fallback, never garbage groups
    const g1 = await createTab({ url: `${baseUrl}/fallbackA` });
    const g2 = await createTab({ url: `${baseUrl}/fallbackB` });
    await sleep(400);
    await swEval(() =>
      globalThis.__ttSetMockAi({ availability: "available", respond: () => "not json at all" }),
    );
    const fb = await ui({ type: "ui:smartOrganize", scope: "all" });
    assert(fb.fellBack === true, "fell back");
    const g1Now = await getTab(g1.id);
    assert(g1Now.groupId !== -1, "domain fallback grouped");
    await swEval(() => globalThis.__ttSetMockAi(null));
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "off" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("restart: reload re-adopts domain groups by 3-of-3 signature", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
    const a = await openViaCommit(`${altUrl}/readopt1`, { active: false });
    const b = await openViaCommit(`${altUrl}/readopt2`, { active: false });
    await waitFor("grouped", async () => (await getTab(b.id)).groupId !== -1);
    const gid = (await getTab(b.id)).groupId;
    await swEval(() => globalThis.__ttSimulateReload());
    await waitFor("re-settled", async () => (await ui({ type: "ui:getState" })).settled);
    await forceSettle();
    const diag = await ui({ type: "ui:diagnostics" });
    assert(diag.ourGroups[String(gid)], "group re-adopted after reload");
    assert(diag.ourGroups[String(gid)].domain === "localhost", "domain restored");
  });

  await test("popup backend: counts match constructed reality; toggles write settings", async () => {
    await forceSettle();
    const state = await ui({ type: "ui:getState" });
    const tabs = await queryTabs();
    assert(state.counts.tabs === tabs.length, `tab count ${state.counts.tabs} == ${tabs.length}`);
    await ui({ type: "ui:setSetting", key: "dedupAuto", value: false });
    assert((await ui({ type: "ui:getState" })).settings.dedupAuto === false, "toggle persisted");
    await ui({ type: "ui:setSetting", key: "dedupAuto", value: true });
    const bad = await ui({ type: "ui:setSetting", key: "nonsense", value: 1 });
    assert(bad.ok === false, "unknown key rejected");
  });

  await test("diagnostics: urls only, key masked, trace present", async () => {
    await swEval(() => chrome.storage.local.set({ byokKey: "sk-secret" }));
    const diag = await ui({ type: "ui:diagnostics" });
    assert(diag.byokKey === "set", "key masked");
    assert(!JSON.stringify(diag).includes("sk-secret"), "raw key never leaves");
    assert(Array.isArray(diag.trace), "trace ring present");
    assert(diag.windows.every((w) => !("titles" in w)), "no titles in dump");
    await swEval(() => chrome.storage.local.remove("byokKey"));
  });

  await test("i18n: en default, ru and zh load with full key parity", async () => {
    const en = await swEval(async () => {
      await ttI18n.init("en");
      return ttI18n.t("actOrganize");
    });
    assert(en === "Organize now", "en loads");
    const ru = await swEval(async () => {
      const lang = await ttI18n.init("ru");
      return { lang, msg: ttI18n.t("actOrganize") };
    });
    assert(ru.lang === "ru" && ru.msg.length > 0, "ru loads");
    const zh = await swEval(async () => {
      const lang = await ttI18n.init("zh-CN");
      return { lang, msg: ttI18n.t("actOrganize") };
    });
    assert(zh.lang === "zh_CN" && zh.msg.length > 0, "zh resolves and loads");
    await swEval(async () => ttI18n.init("en"));
  });

  await test("dedup scope: window default leaves a cross-window duplicate alone; 'all' catches it", async () => {
    await resetWorld();
    const here = await openViaCommit(`${baseUrl}/scoped`, { active: false });
    const win2 = await swEval(
      () => new Promise((r) => chrome.windows.create({ url: "about:blank" }, (w) => r({ id: w.id }))),
    );
    await sleep(300);
    const there = await openViaCommit(`${baseUrl}/scoped`, { windowId: win2.id, active: false });
    await sleep(600);
    assert((await getTab(there.id)) !== null, "window scope: cross-window copy lives");
    await ui({ type: "ui:setSetting", key: "dedupScope", value: "all" });
    const thereDupe = await openViaCommit(`${baseUrl}/scoped`, { windowId: win2.id, active: false });
    await waitFor("all scope: dupe closed", async () => (await getTab(thereDupe.id)) === null);
    await ui({ type: "ui:setSetting", key: "dedupScope", value: "window" });
    await swEval((id) => new Promise((r) => chrome.windows.remove(id, () => r())), win2.id);
  });

  await test("undo organize: created groups dissolve, tabs stay, no strikes recorded", async () => {
    await resetWorld();
    // continuous mode off: the explicit Organize must be the one creating
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "off" });
    const a = await createTab({ url: `${baseUrl}/orgA`, active: false });
    const b = await createTab({ url: `${baseUrl}/orgB`, active: false });
    await sleep(400);
    const org = await ui({ type: "ui:organizeNow", scope: "all" });
    assert(org.groupsCreated >= 1, "group created");
    const state = await ui({ type: "ui:getState" });
    assert(state.lastOrganize && state.lastOrganize.gids.length >= 1, "lastOrganize set");
    const undo = await ui({ type: "ui:undoOrganize" });
    assert(undo.ungrouped >= 2, `ungrouped ${undo.ungrouped} >= 2`);
    assert((await getTab(a.id)).groupId === -1, "tab a loose again");
    assert((await getTab(b.id)) !== null, "tabs alive");
    const diag = await ui({ type: "ui:diagnostics" });
    assert(
      !Object.keys(diag.strikes).some((k) => k.startsWith("group:")),
      "our undo is not a user pull-out",
    );
    const aState = await tabState(a.id);
    assert(!aState.ungroupedByUser, "tab not marked user-ungrouped");
    // organize again still works (nothing retired)
    const again = await ui({ type: "ui:organizeNow", scope: "all" });
    assert(again.groupsCreated >= 1, "regrouping works after undo");
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("archive resurrection: a protected page that pops back strikes out of archiving", async () => {
    await resetWorld();
    const url = `${baseUrl}/lockedPage`;
    const future1 = Date.now() + 25 * 3600e3;
    const v1 = await openViaCommit(url, { active: false });
    await swEval((n) => globalThis.__ttTick({ now: n }), future1);
    await waitFor("archived once", async () => (await getTab(v1.id)) === null);
    // "TruePin" resurrects it: same url comes right back with a real commit
    const v2 = await openViaCommit(url, { active: false });
    await sleep(300);
    await swEval((n) => globalThis.__ttTick({ now: n }), future1 + 26 * 3600e3);
    await waitFor("archived twice", async () => (await getTab(v2.id)) === null);
    const v3 = await openViaCommit(url, { active: false });
    await sleep(300);
    await swEval((n) => globalThis.__ttTick({ now: n }), future1 + 52 * 3600e3);
    await sleep(700);
    assert((await getTab(v3.id)) !== null, "third round: key retired, tab stays");
    const diag = await ui({ type: "ui:diagnostics" });
    const struck = Object.keys(diag.strikes).find(
      (k) => k.startsWith("archive:") && k.includes("lockedPage"),
    );
    assert(struck && diag.strikes[struck].count >= 2, "archive strikes recorded");
  });

  await test("popup groups API: list, fold via command (no strike), focus", async () => {
    await resetWorld();
    const a = await openViaCommit(`${altUrl}/apiG1`, { active: false });
    const b = await openViaCommit(`${altUrl}/apiG2`, { active: false });
    await waitFor("grouped", async () => (await getTab(b.id)).groupId !== -1);
    const gid = (await getTab(b.id)).groupId;
    const state = await ui({ type: "ui:getState" });
    const listed = state.groups.find((g) => g.id === gid);
    assert(listed && listed.ours && listed.tabCount === 2, "group listed with fields");
    await ui({ type: "ui:groupCollapse", gid, collapsed: true });
    assert((await swEval((g) => chrome.tabGroups.get(g), gid)).collapsed, "folded by command");
    await ui({ type: "ui:groupsCollapseAll", collapsed: false });
    await sleep(400);
    assert(!(await swEval((g) => chrome.tabGroups.get(g), gid)).collapsed, "unfolded by command");
    const diag = await ui({ type: "ui:diagnostics" });
    assert(
      !Object.keys(diag.strikes).some((k) => k.startsWith("collapse:")),
      "popup expand is a command, not a strike",
    );
    await ui({ type: "ui:groupFocus", gid });
    await waitFor("focused member", async () => {
      const tabs = await queryTabs({ groupId: gid });
      return tabs.some((t) => t.active);
    });
  });

  await test("sort on organize: alphabetical order applied to loose tabs", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "sortTabs", value: "title" });
    // three different sites (no grouping possible), shuffled titles
    const c = await openViaCommit(`${baseUrl}/zebra`, { active: false });
    const a = await openViaCommit(`${altUrl}/alpha`, { active: false });
    await sleep(300);
    await ui({ type: "ui:organizeNow", scope: "all" });
    await sleep(400);
    const tabs = (await queryTabs()).filter((t) => /alpha|zebra/.test(t.url));
    const ordered = await Promise.all(tabs.map((t) => getTab(t.id)));
    const alphaTab = ordered.find((t) => t.url.includes("alpha"));
    const zebraTab = ordered.find((t) => t.url.includes("zebra"));
    const alphaIndex = await swEval((id) => chrome.tabs.get(id).then((t) => t.index), alphaTab.id);
    const zebraIndex = await swEval((id) => chrome.tabs.get(id).then((t) => t.index), zebraTab.id);
    assert(alphaIndex < zebraIndex, `alpha (${alphaIndex}) before zebra (${zebraIndex})`);
    await ui({ type: "ui:setSetting", key: "sortTabs", value: "off" });
  });

  await test("ungroup: one group and all groups dissolve without strikes", async () => {
    await resetWorld();
    const a = await openViaCommit(`${altUrl}/ug1`, { active: false });
    const b = await openViaCommit(`${altUrl}/ug2`, { active: false });
    await waitFor("grouped", async () => (await getTab(b.id)).groupId !== -1);
    const gid = (await getTab(b.id)).groupId;
    const one = await ui({ type: "ui:groupUngroup", gid });
    assert(one.ungrouped === 2, "one group dissolved");
    assert((await getTab(a.id)).groupId === -1 && (await getTab(b.id)) !== null, "tabs alive, loose");
    // rebuild two groups, then dissolve everything
    await ui({ type: "ui:organizeNow", scope: "all" });
    const c = await openViaCommit(`${baseUrl}/ug3`, { active: false });
    const d = await openViaCommit(`${baseUrl}/ug4`, { active: false });
    await sleep(400);
    await ui({ type: "ui:organizeNow", scope: "all" });
    const all = await ui({ type: "ui:groupsUngroupAll" });
    assert(all.ungrouped >= 4, `all dissolved (${all.ungrouped})`);
    const groupsLeft = await swEval(() => chrome.tabGroups.query({}));
    assert(groupsLeft.length === 0, "no groups left");
    const diag = await ui({ type: "ui:diagnostics" });
    assert(
      !Object.keys(diag.strikes).some((k) => k.startsWith("group:")),
      "commands never strike",
    );
  });

  await test("groups on top: organize lines groups up right after pins", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "groupsOnTop", value: true });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "off" });
    const loose1 = await openViaCommit(`${baseUrl}/looseFirst`, { active: false });
    const g1 = await openViaCommit(`${altUrl}/topA`, { active: false });
    const g2 = await openViaCommit(`${altUrl}/topB`, { active: false });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
    await ui({ type: "ui:organizeNow", scope: "all" });
    await sleep(400);
    const gTab = await getTab(g1.id);
    assert(gTab.groupId !== -1, "grouped");
    const gIndex = await swEval((id) => chrome.tabs.get(id).then((t) => t.index), g1.id);
    const looseIndex = await swEval((id) => chrome.tabs.get(id).then((t) => t.index), loose1.id);
    assert(gIndex < looseIndex, `group (${gIndex}) before loose (${looseIndex})`);
    await ui({ type: "ui:setSetting", key: "groupsOnTop", value: false });
  });

  await test("smart Other: leftovers land in a grey catch-all group at the end", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "builtin" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "off" });
    const t1 = await createTab({ url: `${baseUrl}/themeA1` });
    const t2 = await createTab({ url: `${altUrl}/themeA2` });
    const o1 = await createTab({ url: `${baseUrl}/leftover1` });
    const o2 = await createTab({ url: `${altUrl}/leftover2` });
    await sleep(400);
    await swEval(() =>
      globalThis.__ttSetMockAi({
        availability: "available",
        // The pool is domain-sorted, so pick indices by CONTENT, not position.
        respond: (prompt) => {
          const idx = prompt
            .split("\n")
            .filter((line) => /^\d+\. /.test(line))
            .filter((line) => line.includes("themeA"))
            .map((line) => parseInt(line, 10));
          return JSON.stringify({ groups: [{ name: "Theme", tabIndices: idx }] });
        },
      }),
    );
    const result = await ui({ type: "ui:smartOrganize", scope: "all" });
    assert(result.groupsCreated >= 2, `theme + Other created (${result.groupsCreated})`);
    const oTab = await getTab(o1.id);
    assert(oTab.groupId !== -1, "leftover grouped");
    const otherGroup = await swEval((g) => chrome.tabGroups.get(g), oTab.groupId);
    assert(otherGroup.title === "Other", `catch-all titled Other (got "${otherGroup.title}")`);
    assert(otherGroup.color === "grey", "catch-all grey");
    const oIndex = await swEval((id) => chrome.tabs.get(id).then((t) => t.index), o1.id);
    const tIndex = await swEval((id) => chrome.tabs.get(id).then((t) => t.index), t1.id);
    assert(oIndex > tIndex, "Other sits after the theme group");
    await swEval(() => globalThis.__ttSetMockAi(null));
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "off" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("smart quality gate: a half-empty answer sends the tail to site groups, not Other", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "builtin" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "off" });
    const a1 = await createTab({ url: `${baseUrl}/qa1` });
    const a2 = await createTab({ url: `${altUrl}/qa2` });
    const t1 = await createTab({ url: `${baseUrl}/tail1` });
    const t2 = await createTab({ url: `${baseUrl}/tail2` });
    const t3 = await createTab({ url: `${altUrl}/tailSolo` });
    await sleep(400);
    // the model only clusters 2 of 5: 3 unassigned > half the pool
    await swEval(() =>
      globalThis.__ttSetMockAi({
        availability: "available",
        respond: (prompt) => {
          const idx = prompt
            .split("\n")
            .filter((line) => /^\d+\. /.test(line))
            .filter((line) => line.includes("page-qa"))
            .map((line) => parseInt(line, 10));
          return JSON.stringify({ groups: [{ name: "Theme", tabIndices: idx }] });
        },
      }),
    );
    const result = await ui({ type: "ui:smartOrganize", scope: "all" });
    assert(result.fellBack === true, "quality gate tripped");
    const tail1 = await getTab(t1.id);
    const tail2 = await getTab(t2.id);
    assert(
      tail1.groupId !== -1 && tail1.groupId === tail2.groupId,
      "same-site tail tabs grouped by site",
    );
    const tailGroup = await swEval((g) => chrome.tabGroups.get(g), tail1.groupId);
    assert(tailGroup.title !== "Other", `site group, not Other (got "${tailGroup.title}")`);
    const solo = await getTab(t3.id);
    if (solo.groupId !== -1) {
      const g = await swEval((gid) => chrome.tabGroups.get(gid), solo.groupId);
      const members = await queryTabs({ groupId: solo.groupId });
      throw new Error(
        `singleton grouped: "${g.title}" (${g.color}) with ${members
          .map((m) => m.url.slice(-16))
          .join(", ")}`,
      );
    }
    const { smartProgress } = await swEval(() => chrome.storage.session.get("smartProgress"));
    assert(!smartProgress, "progress cleared when done");
    await swEval(() => globalThis.__ttSetMockAi(null));
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "off" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("settings survive a hostile upgrade: junk normalizes, old keys map over", async () => {
    await swEval(() =>
      chrome.storage.sync.set({
        settings: {
          groupAuto: false,
          sortMode: "title",
          smartAutoAssign: true,
          smartEngine: "builtin",
          archiveAfter: "BOGUS",
          theme: 42,
          archiveAllowlist: "nope",
          nonsense: { deep: true },
          dedupScope: "all",
        },
      }),
    );
    const s = (await ui({ type: "ui:getState" })).settings;
    assert(s.autoGroup === "off", "groupAuto=false maps to off");
    assert(s.sortTabs === "title" && s.sortGroups === "title", "sortMode fans out to both axes");
    assert(s.archiveAfter === "24h", "bogus enum degrades to the default");
    assert(s.theme === "auto", "wrong type degrades to the default");
    assert(Array.isArray(s.archiveAllowlist), "allowlist is an array again");
    assert(!("nonsense" in s) && !("groupAuto" in s), "unknown and retired keys dropped");
    assert(s.dedupScope === "all", "valid values survive untouched");
    // "live" from v1.5/1.6 merges into "recent"
    await ui({ type: "ui:setSetting", key: "sortTabs", value: "live" });
    assert(
      (await ui({ type: "ui:getState" })).settings.sortTabs === "recent",
      "live merges into recent",
    );
    await ui({ type: "ui:setSetting", key: "sortTabs", value: "off" });
    // a bad write through the API degrades too - storage is never poisoned
    await ui({ type: "ui:setSetting", key: "archiveAfter", value: "1000years" });
    assert(
      (await ui({ type: "ui:getState" })).settings.archiveAfter === "24h",
      "bad write degraded on save",
    );
    await swEval(() => chrome.storage.sync.remove("settings"));
  });

  await test("options page: a dead engine leaves a readable page with REAL values and recovery", async () => {
    // the user's actual choices must show even with the engine down: pages
    // paint straight from storage, not from a ui:getState roundtrip
    await ui({ type: "ui:setSetting", key: "archiveAfter", value: "7d" });
    await ui({ type: "ui:setSetting", key: "dedupAuto", value: true });
    const extUrl = (await findSwTarget()).url().replace("background.js", "options.html");
    await swEval(() => {
      globalThis.__ttFailUi = true;
    });
    const page = await browser.newPage();
    await page.goto(extUrl, { waitUntil: "networkidle0" });
    await sleep(600);
    const check = await page.evaluate(() => ({
      down: !document.getElementById("engineDown").hidden,
      body: document.getElementById("engineDown").textContent.trim().length,
      reset: document.getElementById("engineResetBtn").textContent.trim().length,
      label: document.querySelector('[data-i18n="optDupesHeader"]').textContent.trim().length,
      version: document.getElementById("version").textContent.trim().length,
      archiveAfter: document.getElementById("archiveAfter").value,
      dedup: document.getElementById("dedupAuto").checked,
      disabled: document.getElementById("archiveAfter").disabled,
      ready: document.body.classList.contains("ready"),
    }));
    assert(check.down, "engine-down card shown");
    assert(check.body > 0 && check.reset > 0, "card carries localized text");
    assert(check.label > 0, "static labels localized without the engine");
    assert(check.version > 0, "version stamped without the engine");
    assert(check.archiveAfter === "7d", `stored value painted (got ${check.archiveAfter})`);
    assert(check.dedup === true, "toggle painted from storage");
    assert(check.disabled, "controls disabled while the engine is down");
    assert(check.ready, "page revealed");
    await page.close();
    await swEval(() => {
      globalThis.__ttFailUi = false;
    });
    await ui({ type: "ui:setSetting", key: "archiveAfter", value: "24h" });
  });

  await test("getState answers instantly even while the mutation queue grinds", async () => {
    await swEval(() => globalThis.__ttEnqueueSleep(2500));
    const t0 = Date.now();
    const state = await ui({ type: "ui:getState" });
    const elapsed = Date.now() - t0;
    assert(state && state.settings, "state returned");
    assert(elapsed < 800, `off-queue getState (${elapsed}ms < 800ms)`);
    const pong = await ui({ type: "ui:ping" });
    assert(pong.ok === true && pong.version.length > 0, "ping answers");
    await sleep(2600); // let the jam job drain before the next test
  });

  await test("sort axes: groups A-Z among themselves, tabs A-Z inside their group", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "sortGroups", value: "title" });
    await ui({ type: "ui:setSetting", key: "sortTabs", value: "title" });
    const z1 = await openViaCommit(`${altUrl}/zzInside`, { active: false });
    const a1 = await openViaCommit(`${altUrl}/aaInside`, { active: false });
    const m1 = await openViaCommit(`${baseUrl}/mmSiteOne`, { active: false });
    const m2 = await openViaCommit(`${baseUrl}/mmSiteTwo`, { active: false });
    await waitFor(
      "grouped",
      async () => (await getTab(a1.id)).groupId !== -1 && (await getTab(m2.id)).groupId !== -1,
    );
    await ui({ type: "ui:organizeNow", scope: "all" });
    await sleep(500);
    const idx = (id) => swEval((tid) => chrome.tabs.get(tid).then((t) => t.index), id);
    assert((await idx(a1.id)) < (await idx(z1.id)), "aa before zz inside the group");
    const altFirst = Math.min(await idx(a1.id), await idx(z1.id));
    const baseFirst = Math.min(await idx(m1.id), await idx(m2.id));
    assert(altFirst < baseFirst, `aa-group (${altFirst}) before mm-group (${baseFirst})`);
    await ui({ type: "ui:setSetting", key: "sortGroups", value: "off" });
    await ui({ type: "ui:setSetting", key: "sortTabs", value: "off" });
  });

  await test("recency sort: the used tab and its group surface INSTANTLY", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "sortTabs", value: "recent" });
    await ui({ type: "ui:setSetting", key: "sortGroups", value: "recent" });
    const a1 = await openViaCommit(`${altUrl}/mruA1`, { active: false });
    const a2 = await openViaCommit(`${altUrl}/mruA2`, { active: false });
    const b1 = await openViaCommit(`${baseUrl}/mruB1`, { active: false });
    const b2 = await openViaCommit(`${baseUrl}/mruB2`, { active: false });
    await waitFor(
      "grouped",
      async () => (await getTab(a2.id)).groupId !== -1 && (await getTab(b2.id)).groupId !== -1,
    );
    const idx = (id) => swEval((tid) => chrome.tabs.get(tid).then((t) => t.index), id);
    // recency is maintained from the first commit, so build the precondition
    // explicitly: use b1, it surfaces; then use b2 and watch it overtake.
    await swEval((id) => chrome.tabs.update(id, { active: true }), b1.id);
    await waitFor("b1 surfaced first", async () => (await idx(b1.id)) < (await idx(b2.id)), 2500);
    await sleep(900); // out of the cycling-guard window: the next switch is calm
    await swEval((id) => chrome.tabs.update(id, { active: true }), b2.id);
    // zero dwell on a calm switch: both moves land in well under 2.5s
    await waitFor(
      "tab surfaced in its group",
      async () => (await idx(b2.id)) < (await idx(b1.id)),
      2500,
    );
    await waitFor(
      "group surfaced in the strip",
      async () => {
        const bFirst = Math.min(await idx(b1.id), await idx(b2.id));
        const aFirst = Math.min(await idx(a1.id), await idx(a2.id));
        return bFirst < aFirst;
      },
      2500,
    );
    await ui({ type: "ui:setSetting", key: "sortTabs", value: "off" });
    await ui({ type: "ui:setSetting", key: "sortGroups", value: "off" });
  });

  await test("maintained sort: new tabs slot in alphabetically, a manual drag snaps back", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "sortTabs", value: "title" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "off" }); // keep them loose
    const z = await openViaCommit(`${baseUrl}/zzMaint`, { active: false });
    const a = await openViaCommit(`${altUrl}/aaMaint`, { active: false });
    const idx = (id) => swEval((tid) => chrome.tabs.get(tid).then((t) => t.index), id);
    // no Organize click: the commit itself slots aa before zz
    await waitFor("aa slots before zz", async () => (await idx(a.id)) < (await idx(z.id)), 5000);
    // let the engine go quiet, then "drag" zz to the front by hand
    await sleep(1400);
    await swEval((tid) => chrome.tabs.move(tid, { index: 0 }), z.id);
    await waitFor("zz moved by hand", async () => (await idx(z.id)) < (await idx(a.id)), 2000);
    await waitFor("the invariant snaps it back", async () => (await idx(a.id)) < (await idx(z.id)), 5000);
    await ui({ type: "ui:setSetting", key: "sortTabs", value: "off" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("maintained sort: a newborn group takes its alphabetical place", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "sortGroups", value: "title" });
    const m1 = await openViaCommit(`${baseUrl}/mmFirst1`, { active: false });
    const m2 = await openViaCommit(`${baseUrl}/mmFirst2`, { active: false });
    await waitFor("mm grouped", async () => (await getTab(m2.id)).groupId !== -1);
    const a1 = await openViaCommit(`${altUrl}/aaSecond1`, { active: false });
    const a2 = await openViaCommit(`${altUrl}/aaSecond2`, { active: false });
    await waitFor("aa grouped", async () => (await getTab(a2.id)).groupId !== -1);
    const idx = (id) => swEval((tid) => chrome.tabs.get(tid).then((t) => t.index), id);
    await waitFor(
      "aa group lines up before mm group without Organize",
      async () => {
        const aFirst = Math.min(await idx(a1.id), await idx(a2.id));
        const mFirst = Math.min(await idx(m1.id), await idx(m2.id));
        return aFirst < mFirst;
      },
      5000,
    );
    await ui({ type: "ui:setSetting", key: "sortGroups", value: "off" });
  });

  await test("options: the grouping pair moves together, both directions", async () => {
    const extUrl = (await findSwTarget()).url().replace("background.js", "options.html");
    const page = await browser.newPage();
    await page.goto(extUrl, { waitUntil: "networkidle0" });
    await sleep(400);
    await page.select("#smartEngine", "builtin");
    await sleep(350);
    let v = await page.$eval("#autoGroup", (el) => el.value);
    assert(v === "topic", `engine on flips grouping to topic (got ${v})`);
    await page.select("#smartEngine", "off");
    await sleep(350);
    v = await page.$eval("#autoGroup", (el) => el.value);
    assert(v === "site", `engine off drops grouping to site (got ${v})`);
    await page.select("#autoGroup", "topic");
    await sleep(350);
    v = await page.$eval("#smartEngine", (el) => el.value);
    assert(v === "builtin", `topic auto-picks the built-in engine (got ${v})`);
    await page.close();
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "off" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("popup reorder: the final drag order lands on the strip", async () => {
    await resetWorld();
    const a1 = await openViaCommit(`${altUrl}/roA1`, { active: false });
    const a2 = await openViaCommit(`${altUrl}/roA2`, { active: false });
    const b1 = await openViaCommit(`${baseUrl}/roB1`, { active: false });
    const b2 = await openViaCommit(`${baseUrl}/roB2`, { active: false });
    await waitFor(
      "grouped",
      async () => (await getTab(a2.id)).groupId !== -1 && (await getTab(b2.id)).groupId !== -1,
    );
    const gA = (await getTab(a1.id)).groupId;
    const gB = (await getTab(b1.id)).groupId;
    const winId = (await getTab(a1.id)).windowId;
    const res = await ui({ type: "ui:groupReorder", windowId: winId, gids: [gB, gA] });
    assert(res.ok, "reorder accepted");
    const idx = (id) => swEval((tid) => chrome.tabs.get(tid).then((t) => t.index), id);
    assert((await idx(b1.id)) < (await idx(a1.id)), "B group now before A group");
  });

  await test("custom rules: a listed site routes to the user's group before site grouping", async () => {
    await resetWorld();
    const saved = await ui({
      type: "ui:customGroups:set",
      list: [{ id: "r1", name: "Video", domains: ["localhost"], hint: "", on: true }],
    });
    assert(saved.ok && saved.customGroups.length === 1, "rule saved");
    const v1 = await openViaCommit(`${altUrl}/videoPage1`, { active: false });
    await waitFor("routed", async () => (await getTab(v1.id)).groupId !== -1);
    const gid = (await getTab(v1.id)).groupId;
    const group = await swEval((g) => chrome.tabGroups.get(g), gid);
    assert(group.title === "Video", `rule group titled Video (got "${group.title}")`);
    const v2 = await openViaCommit(`${altUrl}/videoPage2`, { active: false });
    await waitFor("second joins", async () => (await getTab(v2.id)).groupId === gid);
    const plain = await openViaCommit(`${baseUrl}/plainPage`, { active: false });
    await sleep(400);
    assert((await getTab(plain.id)).groupId !== gid, "unmatched site not routed");
    await ui({ type: "ui:customGroups:set", list: [] });
  });

  await test("smart honors the user's rule group: name reserved, hint-matched tabs land there", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "builtin" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "off" });
    await ui({
      type: "ui:customGroups:set",
      list: [{ id: "r2", name: "Research", domains: [], hint: "research papers", on: true }],
    });
    const r1 = await createTab({ url: `${baseUrl}/resPaper1` });
    const r2 = await createTab({ url: `${altUrl}/resPaper2` });
    await sleep(400);
    await swEval(() =>
      globalThis.__ttSetMockAi({
        availability: "available",
        // answers with a LOWER-CASED name: must still map to the exact rule
        respond: (prompt) => {
          const idx = prompt
            .split("\n")
            .filter((line) => /^\d+\. /.test(line))
            .filter((line) => line.includes("resPaper"))
            .map((line) => parseInt(line, 10));
          return JSON.stringify({ groups: [{ name: "research", tabIndices: idx }] });
        },
      }),
    );
    const result = await ui({ type: "ui:smartOrganize", scope: "all" });
    assert(result.grouped >= 2, "tabs grouped");
    const gid = (await getTab(r1.id)).groupId;
    assert(gid !== -1 && gid === (await getTab(r2.id)).groupId, "both in one group");
    const group = await swEval((g) => chrome.tabGroups.get(g), gid);
    assert(group.title === "Research", `rule name kept exactly (got "${group.title}")`);
    await swEval(() => globalThis.__ttSetMockAi(null));
    await ui({ type: "ui:customGroups:set", list: [] });
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "off" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("topic mode: a new tab joins its topic group live; site fallback without an engine", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "builtin" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "topic" });
    const c1 = await createTab({ url: `${baseUrl}/catsSeed1` });
    const c2 = await createTab({ url: `${altUrl}/catsSeed2` });
    await sleep(400);
    await swEval(() =>
      globalThis.__ttSetMockAi({
        availability: "available",
        respond: (prompt) => {
          if (prompt.includes("Pick the best topic group")) {
            return JSON.stringify({ group: 0 });
          }
          const idx = prompt
            .split("\n")
            .filter((line) => /^\d+\. /.test(line))
            .filter((line) => line.includes("catsSeed"))
            .map((line) => parseInt(line, 10));
          return JSON.stringify({ groups: [{ name: "Cats", tabIndices: idx }] });
        },
      }),
    );
    await ui({ type: "ui:smartOrganize", scope: "all" });
    const gid = (await getTab(c1.id)).groupId;
    assert(gid !== -1, "seed topic group exists");
    const fresh = await openViaCommit(`${baseUrl}/catsNews`, { active: false });
    await waitFor(
      "live-assigned to the topic",
      async () => (await getTab(fresh.id)).groupId === gid,
    );
    // engine gone: topic mode degrades to site grouping, never to nothing
    await swEval(() => globalThis.__ttSetMockAi(null));
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "off" });
    const f1 = await openViaCommit(`${altUrl}/fbSite1`, { active: false });
    const f2 = await openViaCommit(`${altUrl}/fbSite2`, { active: false });
    await waitFor("site fallback grouped", async () => (await getTab(f2.id)).groupId !== -1);
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("smart incremental: batches apply as they land, one undo covers the run", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "builtin" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "off" });
    const made = [];
    for (let i = 0; i < 17; i++) {
      made.push(await createTab({ url: `${baseUrl}/multi${i < 9 ? "Alpha" : "Beta"}${i}` }));
    }
    // Wait for the world, do not hope for it: a tab that has not reported its
    // URL yet is not in the pool, and the run would legitimately group 15.
    await waitFor("all 17 tabs carry their url", async () => {
      const urls = await Promise.all(made.map(async (m) => (await getTab(m.id))?.url || ""));
      return urls.every((u) => u.includes("multi"));
    }, 10_000);
    await swEval(() =>
      globalThis.__ttSetMockAi({
        availability: "available",
        respond: (prompt) => {
          const lines = prompt.split("\n").filter((line) => /^\d+\. /.test(line));
          const groups = [];
          for (const [name, marker] of [
            ["Alpha", "multiAlpha"],
            ["Beta", "multiBeta"],
          ]) {
            const idx = lines
              .filter((line) => line.includes(marker))
              .map((line) => parseInt(line, 10));
            if (idx.length) groups.push({ name, tabIndices: idx });
          }
          return JSON.stringify({ groups });
        },
      }),
    );
    const result = await ui({ type: "ui:smartOrganize", scope: "all" });
    assert(result.groupsCreated === 2, `two theme groups across batches (${result.groupsCreated})`);
    assert(result.grouped >= 17, `all 17 grouped (${result.grouped})`);
    const state = await ui({ type: "ui:getState" });
    assert(state.lastOrganize.gids.length === 2, "one undo record for the whole run");
    const undo = await ui({ type: "ui:undoOrganize" });
    assert(undo.ungrouped >= 17, `undo dissolves the whole run (${undo.ungrouped})`);
    await swEval(() => globalThis.__ttSetMockAi(null));
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "off" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("smart streaming: per-tab progress moves inside a single batch", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "builtin" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "off" });
    const n = 8;
    for (let i = 0; i < n; i++) await createTab({ url: `${baseUrl}/streamPg${i}` });
    await sleep(500);
    await swEval(() =>
      globalThis.__ttSetMockAi({
        availability: "available",
        respondStream: async (prompt, onChunk) => {
          const idx = prompt
            .split("\n")
            .filter((line) => /^\d+\. /.test(line))
            .filter((line) => line.includes("streamPg"))
            .map((line) => parseInt(line, 10));
          const full = JSON.stringify({ groups: [{ name: "Stream", tabIndices: idx }] });
          const mid = Math.floor(full.length * 0.55);
          onChunk(full.slice(0, mid));
          await new Promise((r) => setTimeout(r, 450));
          onChunk(full.slice(mid)); // delta-style second chunk
          await new Promise((r) => setTimeout(r, 200));
          return full;
        },
      }),
    );
    const seen = [];
    const runPromise = ui({ type: "ui:smartOrganize", scope: "all" });
    for (let i = 0; i < 12; i++) {
      const { smartProgress } = await swEval(() => chrome.storage.session.get("smartProgress"));
      if (smartProgress) seen.push(smartProgress.done);
      await sleep(60);
    }
    const result = await runPromise;
    assert(result.grouped >= n, "all streamed tabs grouped");
    assert(
      seen.some((d) => d > 0 && d < n),
      `intermediate per-tab progress observed (saw: ${seen.join(",") || "nothing"})`,
    );
    await swEval(() => globalThis.__ttSetMockAi(null));
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "off" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("pre-commit dedup: a fresh duplicate dies before the page even loads", async () => {
    await resetWorld();
    // the existing copy loads once (1.5s page), then sits open
    const keeper = await openViaCommit(`${baseUrl}/slowKeeper`, { active: false });
    await waitFor("keeper committed", async () => {
      const st = await tabState(keeper.id);
      return st && st.committedCount >= 1;
    });
    // a fresh tab heads to the same URL: it must be pre-empted at
    // onBeforeNavigate - far sooner than the 1.5s the page needs to commit
    const t0 = Date.now();
    const dupe = await createTab({ url: "about:blank", active: true });
    await swEval(
      (id, u) =>
        new Promise((r) =>
          chrome.tabs.update(id, { url: u }, () => {
            void chrome.runtime.lastError;
            r();
          }),
        ),
      dupe.id,
      `${baseUrl}/slowKeeper`,
    );
    await waitFor("duplicate pre-empted", async () => (await getTab(dupe.id)) === null);
    const elapsed = Date.now() - t0;
    assert(elapsed < 1200, `closed before the load could finish (${elapsed}ms < 1200ms)`);
    const keeperNow = await getTab(keeper.id);
    assert(keeperNow.active, "focus jumped to the existing copy");
  });

  await test("address-bar re-navigation: the stale copy merges INTO the user's tab", async () => {
    await resetWorld();
    const stale = await openViaCommit(`${baseUrl}/mergeTarget`, { active: false });
    // the user's tab lives in a site group and has history
    const mine = await openViaCommit(`${altUrl}/mineA`, { active: false });
    const mine2 = await openViaCommit(`${altUrl}/mineB`, { active: false });
    await waitFor("grouped", async () => (await getTab(mine.id)).groupId !== -1);
    await swEval((id) => chrome.tabs.update(id, { active: true }), mine.id);
    // navigate it for real (commits as "link" - harmless), then replay the
    // commit as TYPED: the API cannot produce a typed transition itself
    await swEval(
      (id, u) => new Promise((r) => chrome.tabs.update(id, { url: u }, () => r())),
      mine.id,
      `${baseUrl}/mergeTarget`,
    );
    await waitFor("navigated", async () => (await getTab(mine.id)).url.includes("mergeTarget"));
    await swEval(
      (id, u) => globalThis.__ttSimulateCommit({ tabId: id, url: u, transitionType: "typed" }),
      mine.id,
      `${baseUrl}/mergeTarget`,
    );
    await waitFor("stale copy merged away", async () => (await getTab(stale.id)) === null);
    assert((await getTab(mine.id)) !== null, "the user's tab survives");
    assert((await getTab(mine.id)).active, "and keeps the focus");
    const entries = await archiveEntries();
    assert(
      entries.some((e) => e.url.includes("mergeTarget") && e.reason === "merge"),
      "victim archived before closing",
    );
    // and the survivor left the now-wrong site group (localhost group,
    // 127.0.0.1 page) - the group's name stays honest
    await waitFor("released from the mismatched group", async () => (await getTab(mine.id)).groupId === -1);
  });

  await test("re-home on typed navigation: the user's rule wins, else the domain's group", async () => {
    await resetWorld();
    await ui({
      type: "ui:customGroups:set",
      list: [{ id: "rv", name: "Video", domains: ["localhost"], hint: "", on: true }],
    });
    // an old loose tab types a rule-matched URL -> re-filed into "Video"
    const t = await openViaCommit(`${baseUrl}/plainStart`, { active: false });
    await swEval(
      (id, u) => new Promise((r) => chrome.tabs.update(id, { url: u }, () => r())),
      t.id,
      `${altUrl}/videoLand`,
    );
    await waitFor("navigated", async () => (await getTab(t.id)).url.includes("videoLand"));
    await swEval(
      (id, u) => globalThis.__ttSimulateCommit({ tabId: id, url: u, transitionType: "typed" }),
      t.id,
      `${altUrl}/videoLand`,
    );
    await waitFor("re-filed by the rule", async () => (await getTab(t.id)).groupId !== -1);
    const ruleGroup = await swEval((g) => chrome.tabGroups.get(g), (await getTab(t.id)).groupId);
    assert(ruleGroup.title === "Video", `rule group (got "${ruleGroup.title}")`);
    await ui({ type: "ui:customGroups:set", list: [] });
    // no rule: an old loose tab types a URL whose domain has OUR group -> joins it
    const g1 = await openViaCommit(`${baseUrl}/homeSite1`, { active: false });
    const g2 = await openViaCommit(`${baseUrl}/homeSite2`, { active: false });
    await waitFor("site group exists", async () => (await getTab(g2.id)).groupId !== -1);
    const siteGid = (await getTab(g2.id)).groupId;
    const j = await openViaCommit(`${altUrl}/joinerStart`, { active: false });
    await swEval(
      (id, u) => new Promise((r) => chrome.tabs.update(id, { url: u }, () => r())),
      j.id,
      `${baseUrl}/homeSite3`,
    );
    await waitFor("navigated", async () => (await getTab(j.id)).url.includes("homeSite3"));
    await swEval(
      (id, u) => globalThis.__ttSimulateCommit({ tabId: id, url: u, transitionType: "typed" }),
      j.id,
      `${baseUrl}/homeSite3`,
    );
    await waitFor("joined the domain's group", async () => (await getTab(j.id)).groupId === siteGid);
  });

  await test("closing grouped tabs is not a pull-out: no strikes, domain keeps grouping", async () => {
    await resetWorld();
    const c1 = await openViaCommit(`${altUrl}/closeG1`, { active: false });
    const c2 = await openViaCommit(`${altUrl}/closeG2`, { active: false });
    await waitFor("grouped", async () => (await getTab(c2.id)).groupId !== -1);
    // the user closes the whole group, tab by tab
    await swEval((ids) => Promise.all(ids.map((id) => chrome.tabs.remove(id))), [c1.id, c2.id]);
    await sleep(600);
    const diag = await ui({ type: "ui:diagnostics" });
    assert(
      !Object.keys(diag.strikes).some((k) => k.startsWith("group:")),
      `closures never strike (got ${JSON.stringify(diag.strikes)})`,
    );
    // and the domain still auto-groups right after
    const c3 = await openViaCommit(`${altUrl}/closeG3`, { active: false });
    const c4 = await openViaCommit(`${altUrl}/closeG4`, { active: false });
    await waitFor("regrouped", async () => (await getTab(c4.id)).groupId !== -1);
  });

  await test("zones maintained: the group block packs before loose, composed with A-Z", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "groupsOnTop", value: true });
    await ui({ type: "ui:setSetting", key: "sortGroups", value: "title" });
    // the keeper blank is the loose tab; two groups get born after it
    const blank = (await queryTabs()).find((t) => !/^https?:/.test(t.url));
    const m1 = await openViaCommit(`${baseUrl}/mmZone1`, { active: false });
    const m2 = await openViaCommit(`${baseUrl}/mmZone2`, { active: false });
    await waitFor("mm grouped", async () => (await getTab(m2.id)).groupId !== -1);
    const a1 = await openViaCommit(`${altUrl}/aaZone1`, { active: false });
    const a2 = await openViaCommit(`${altUrl}/aaZone2`, { active: false });
    await waitFor("aa grouped", async () => (await getTab(a2.id)).groupId !== -1);
    const idx = (id) => swEval((tid) => chrome.tabs.get(tid).then((t) => t.index), id);
    await waitFor(
      "aa group first, mm group second, loose tab after the block",
      async () => {
        const aFirst = Math.min(await idx(a1.id), await idx(a2.id));
        const mFirst = Math.min(await idx(m1.id), await idx(m2.id));
        return aFirst < mFirst && mFirst < (await idx(blank.id));
      },
      6000,
    );
    // drag the loose tab to the very front by hand: the zone snaps it back
    await sleep(1400);
    await swEval((tid) => chrome.tabs.move(tid, { index: 0 }), blank.id);
    await waitFor(
      "the zone re-asserts itself",
      async () => {
        const aFirst = Math.min(await idx(a1.id), await idx(a2.id));
        return (await idx(blank.id)) > aFirst;
      },
      6000,
    );
    await ui({ type: "ui:setSetting", key: "groupsOnTop", value: false });
    await ui({ type: "ui:setSetting", key: "sortGroups", value: "off" });
  });

  await test("restart: smart topic groups re-adopt by signature - ownership survives", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "builtin" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "off" });
    const t1 = await createTab({ url: `${baseUrl}/sigTopic1` });
    const t2 = await createTab({ url: `${altUrl}/sigTopic2` });
    await sleep(400);
    await swEval(() =>
      globalThis.__ttSetMockAi({
        availability: "available",
        respond: (prompt) => {
          const idx = prompt
            .split("\n")
            .filter((line) => /^\d+\. /.test(line))
            .filter((line) => line.includes("sigTopic"))
            .map((line) => parseInt(line, 10));
          return JSON.stringify({ groups: [{ name: "Topic Keep", tabIndices: idx }] });
        },
      }),
    );
    await ui({ type: "ui:smartOrganize", scope: "all" });
    const gid = (await getTab(t1.id)).groupId;
    assert(gid !== -1, "smart group exists");
    await swEval(() => globalThis.__ttSimulateReload());
    await waitFor("re-settled", async () => (await ui({ type: "ui:getState" })).settled);
    await forceSettle();
    const diag = await ui({ type: "ui:diagnostics" });
    assert(
      diag.ourGroups[String(gid)] && diag.ourGroups[String(gid)].smart === true,
      "smart group re-adopted as ours after the restart",
    );
    await swEval(() => globalThis.__ttSetMockAi(null));
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "off" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("Other sweeps everything: extension pages land in the catch-all", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "builtin" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "off" });
    const extBase = (await findSwTarget()).url().replace("background.js", "");
    const p1 = await createTab({ url: `${extBase}options.html`, active: false });
    const p2 = await createTab({ url: `${extBase}archive.html`, active: false });
    const h1 = await createTab({ url: `${baseUrl}/webTheme1` });
    const h2 = await createTab({ url: `${altUrl}/webTheme2` });
    await sleep(500);
    await swEval(() =>
      globalThis.__ttSetMockAi({
        availability: "available",
        respond: (prompt) => {
          const idx = prompt
            .split("\n")
            .filter((line) => /^\d+\. /.test(line))
            .filter((line) => line.includes("webTheme"))
            .map((line) => parseInt(line, 10));
          return JSON.stringify({ groups: [{ name: "Web", tabIndices: idx }] });
        },
      }),
    );
    await ui({ type: "ui:smartOrganize", scope: "all" });
    await waitFor(
      "extension pages grouped together",
      async () =>
        (await getTab(p1.id)).groupId !== -1 &&
        (await getTab(p2.id)).groupId === (await getTab(p1.id)).groupId,
    );
    const other = await swEval((g) => chrome.tabGroups.get(g), (await getTab(p1.id)).groupId);
    assert(other.title === "Other", `the catch-all holds them (got "${other.title}")`);
    assert((await getTab(h1.id)).groupId !== (await getTab(p1.id)).groupId, "web theme separate");
    await swEval(() => globalThis.__ttSetMockAi(null));
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "off" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("topic mode + Other: an unmatched new tab joins the catch-all, never stays loose", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "builtin" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "topic" });
    // seed a topic group so the catch-all is not the only group around
    const s1 = await createTab({ url: `${baseUrl}/seedTopicA` });
    const s2 = await createTab({ url: `${altUrl}/seedTopicB` });
    await sleep(400);
    await swEval(() =>
      globalThis.__ttSetMockAi({
        availability: "available",
        respond: (prompt) => {
          if (prompt.includes("Pick the best topic group")) {
            return JSON.stringify({ group: null }); // fits nothing
          }
          const idx = prompt
            .split("\n")
            .filter((line) => /^\d+\. /.test(line))
            .filter((line) => line.includes("seedTopic"))
            .map((line) => parseInt(line, 10));
          return JSON.stringify({ groups: [{ name: "Seeded", tabIndices: idx }] });
        },
      }),
    );
    await ui({ type: "ui:smartOrganize", scope: "all" });
    // two fresh tabs the model refuses to place: they must land in Other
    const l1 = await openViaCommit(`${baseUrl}/lonelyOne`, { active: false });
    const l2 = await openViaCommit(`${altUrl}/lonelyTwo`, { active: false });
    await waitFor(
      "both lonely tabs grouped",
      async () => (await getTab(l1.id)).groupId !== -1 && (await getTab(l2.id)).groupId !== -1,
      8000,
    );
    const g = await swEval((gid) => chrome.tabGroups.get(gid), (await getTab(l2.id)).groupId);
    assert(g.title === "Other", `the catch-all took them (got "${g.title}")`);
    await swEval(() => globalThis.__ttSetMockAi(null));
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "off" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("stale smart flags never outlive the worker; resume takes automation back", async () => {
    await resetWorld();
    // a killed worker mid-run used to leave these behind: popup frozen on
    // "Grouping...", Smart Organize blocked for ten minutes
    await swEval(() =>
      chrome.storage.session.set({
        smartProgress: { done: 3, total: 70 },
        smartRunning: Date.now(),
      }),
    );
    await swEval(() => globalThis.__ttSimulateReload());
    await waitFor("re-settled", async () => (await ui({ type: "ui:getState" })).settled);
    const state = await ui({ type: "ui:getState" });
    assert(!state.smartProgress, "stale progress cleared by the fresh worker");
    const { smartRunning } = await swEval(() => chrome.storage.session.get("smartRunning"));
    assert(!smartRunning, "stale running flag cleared - smart is not blocked");
    // retired automation is visible and revocable
    await swEval(() =>
      chrome.storage.session.set({
        strikes: { "dedup:http://x/y": { count: 2, lastAt: Date.now() } },
        pausedUntil: Date.now() + 60_000,
      }),
    );
    const struck = await ui({ type: "ui:getState" });
    assert(struck.retired === 1, `retired classes surfaced (got ${struck.retired})`);
    assert(struck.paused === true, "pause surfaced");
    await ui({ type: "ui:resumeAutomation" });
    const back = await ui({ type: "ui:getState" });
    assert(back.retired === 0 && back.paused === false, "resume clears both");
  });

  await test("diagnostics answers off-queue while the mutation queue grinds", async () => {
    await swEval(() => globalThis.__ttEnqueueSleep(2500));
    const t0 = Date.now();
    const dump = await ui({ type: "ui:diagnostics" });
    const elapsed = Date.now() - t0;
    assert(dump && dump.version && Array.isArray(dump.trace), "dump returned");
    assert(elapsed < 800, `off-queue diagnostics (${elapsed}ms < 800ms)`);
    await sleep(2600); // let the jam drain
  });

  await test("dedup covers any real page: three file:// copies collapse to one", async () => {
    await resetWorld();
    const fileUrl = `file://${filePagePath}`;
    const first = await openViaCommit(fileUrl, { active: false });
    await waitFor("first file tab committed", async () => {
      const st = await tabState(first.id);
      return st && st.key;
    });
    const st = await tabState(first.id);
    assert(st.key.startsWith("file://"), `file pages get an identity (got ${st.key})`);
    // two more copies: both must be pre-empted, exactly like a website
    const dupe1 = await openViaCommit(fileUrl, { active: false });
    await waitFor("second copy closed", async () => (await getTab(dupe1.id)) === null);
    const dupe2 = await openViaCommit(fileUrl, { active: false });
    await waitFor("third copy closed", async () => (await getTab(dupe2.id)) === null);
    assert((await getTab(first.id)) !== null, "the original stays");
    // and the sweep counts them as duplicates too
    const c1 = await createTab({ url: fileUrl, active: false });
    const c2 = await createTab({ url: fileUrl, active: false });
    await sleep(500);
    const state = await ui({ type: "ui:getState" });
    assert(state.counts.dupes >= 2, `counter sees file dupes (got ${state.counts.dupes})`);
    const swept = await ui({ type: "ui:sweepDupes", scope: "all" });
    assert(swept.closed >= 2, `sweep closed them (${swept.closed})`);
    const left = (await queryTabs()).filter((t) => t.url.startsWith("file://"));
    assert(left.length === 1, `exactly one copy survives (got ${left.length})`);
    // never archived, and never an archive row we cannot honour: a local page
    // is not restorable, so we do not promise it back
    assert(
      !(await archiveEntries()).some((e) => e.url.startsWith("file://")),
      "no file:// rows in the archive",
    );
    await swEval((n) => globalThis.__ttTick({ now: n }), Date.now() + 30 * 3600e3);
    await sleep(600);
    assert((await getTab(left[0].id)) !== null, "file page not archived by the stale scan");
  });

  await test("Other without AI: site grouping parks strays, a real site group wins them back", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "off" });
    // two lone domains: neither can form a site group (min size 2)
    const solo1 = await openViaCommit(`${baseUrl}/soloAlpha`, { active: false });
    const solo2 = await openViaCommit(`${altUrl}/soloBeta`, { active: false });
    await waitFor(
      "strays parked in Other with no AI in sight",
      async () => (await getTab(solo1.id)).groupId !== -1 && (await getTab(solo2.id)).groupId !== -1,
      8000,
    );
    const gid = (await getTab(solo1.id)).groupId;
    const other = await swEval((g) => chrome.tabGroups.get(g), gid);
    assert(other.title === "Other" && other.color === "grey", `grey Other (got "${other.title}")`);
    assert((await getTab(solo2.id)).groupId === gid, "both in the same catch-all");
    // a second tab of solo1's domain arrives: the real site group is born and
    // takes its tab back out of Other
    const peer = await openViaCommit(`${baseUrl}/soloAlphaPeer`, { active: false });
    await waitFor(
      "site group born from the catch-all",
      async () => {
        const t = await getTab(peer.id);
        const s = await getTab(solo1.id);
        return t.groupId !== -1 && t.groupId !== gid && s.groupId === t.groupId;
      },
      8000,
    );
    const siteGroup = await swEval((g) => chrome.tabGroups.get(g), (await getTab(peer.id)).groupId);
    assert(siteGroup.title !== "Other", `real site group (got "${siteGroup.title}")`);
    assert((await getTab(solo2.id)).groupId === gid, "the other stray stays in Other");
  });

  await test("organize reclaims Other: the button sees the parking lot", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
    // two lone domains park in Other (no site group can form from singletons)
    const a1 = await openViaCommit(`${baseUrl}/reclaimA`, { active: false });
    const b1 = await openViaCommit(`${altUrl}/reclaimB`, { active: false });
    await waitFor("parked", async () => (await getTab(a1.id)).groupId !== -1, 8000);
    const otherGid = (await getTab(a1.id)).groupId;
    // a second tab of a1's domain arrives while grouping is OFF: it stays put
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "off" });
    const a2 = await createTab({ url: `${baseUrl}/reclaimA2`, active: false });
    await sleep(500);
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
    // the user presses Organize: it must look INSIDE Other, not past it
    await ui({ type: "ui:organizeNow", scope: "all" });
    await waitFor(
      "site group born out of the catch-all",
      async () => {
        const t1 = await getTab(a1.id);
        const t2 = await getTab(a2.id);
        return t1.groupId !== -1 && t1.groupId !== otherGid && t1.groupId === t2.groupId;
      },
      6000,
    );
    assert((await getTab(b1.id)).groupId === otherGid, "the true stray stays parked");
  });

  await test("AI on never resurrects grouping the user turned off", async () => {
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "off" });
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "builtin" });
    const s1 = (await ui({ type: "ui:getState" })).settings;
    assert(s1.autoGroup === "off", `grouping stays off (got ${s1.autoGroup})`);
    assert(s1.smartEngine === "builtin", "the engine choice is remembered");
    // and the pairing itself lives in the engine, with no page open
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "topic" });
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "off" });
    const s2 = (await ui({ type: "ui:getState" })).settings;
    assert(s2.autoGroup === "site", `engine off drops grouping to site (got ${s2.autoGroup})`);
    const back = await ui({ type: "ui:setSetting", key: "smartEngine", value: "builtin" });
    assert(back.settings.autoGroup === "topic", "engine on flips grouping to topic");
    assert(back.settings.smartEngine === "builtin", "the answer carries both keys");
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "off" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("a new rule drains Other on the next tick, without a click", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
    const v1 = await openViaCommit(`${altUrl}/ruleDrain1`, { active: false });
    const p1 = await openViaCommit(`${baseUrl}/plainStray`, { active: false });
    await waitFor("parked", async () => (await getTab(v1.id)).groupId !== -1, 8000);
    const otherGid = (await getTab(v1.id)).groupId;
    // the user writes a rule that matches one of the parked tabs
    await ui({
      type: "ui:customGroups:set",
      list: [{ id: "rd", name: "Video", domains: ["localhost"], hint: "", on: true }],
    });
    await swEval(() => globalThis.__ttTick({}));
    await waitFor(
      "the rule reclaims its tab from the parking lot",
      async () => {
        const t = await getTab(v1.id);
        if (t.groupId === -1 || t.groupId === otherGid) return false;
        const g = await swEval((gid) => chrome.tabGroups.get(gid), t.groupId);
        return g.title === "Video";
      },
      6000,
    );
    assert((await getTab(p1.id)).groupId === otherGid, "the unmatched stray stays");
    await ui({ type: "ui:customGroups:set", list: [] });
  });

  await test("the review is idempotent and quiet: no work when nothing changed", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
    const t1 = await openViaCommit(`${baseUrl}/idemA`, { active: false });
    const t2 = await openViaCommit(`${baseUrl}/idemB`, { active: false });
    await waitFor("site group", async () => (await getTab(t2.id)).groupId !== -1);
    const snap = async () =>
      JSON.stringify((await queryTabs()).map((t) => [t.id, t.groupId, t.index]).sort());
    const before = await snap();
    await swEval(() => globalThis.__ttTick({}));
    await sleep(400);
    await swEval(() => globalThis.__ttTick({}));
    await sleep(400);
    assert((await snap()) === before, "two ticks moved nothing");
  });

  await test("topic mode: the automatic review never mints site groups (no churn loop)", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "builtin" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "topic" });
    await swEval(() =>
      globalThis.__ttSetMockAi({
        availability: "available",
        respond: () => JSON.stringify({ groups: [] }), // the model declines everything
      }),
    );
    const c1 = await openViaCommit(`${baseUrl}/churnA`, { active: false });
    const c2 = await openViaCommit(`${baseUrl}/churnB`, { active: false });
    const c3 = await openViaCommit(`${baseUrl}/churnC`, { active: false });
    await waitFor("parked in Other", async () => (await getTab(c3.id)).groupId !== -1, 8000);
    const otherGid = (await getTab(c3.id)).groupId;
    const g = await swEval((gid) => chrome.tabGroups.get(gid), otherGid);
    assert(g.title === "Other", `they sit in the catch-all (got "${g.title}")`);
    // force the review: in topic mode it must do rules only - a site group
    // here would be dissolved by the next smart run, forever
    await ui({ type: "ui:setSetting", key: "otherGroup", value: true });
    await swEval(() => globalThis.__ttTick({}));
    await sleep(600);
    for (const t of [c1, c2, c3]) {
      assert((await getTab(t.id)).groupId === otherGid, "still parked, no site group minted");
    }
    await swEval(() => globalThis.__ttSetMockAi(null));
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "off" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("the review respects hands-off tabs and stays mute while paused", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
    const h1 = await openViaCommit(`${altUrl}/handsA`, { active: false });
    const h2 = await openViaCommit(`${altUrl}/handsB`, { active: false });
    await waitFor("grouped", async () => (await getTab(h2.id)).groupId !== -1);
    // the user pulls h1 out by hand: it must never be re-grouped
    await swEval((id) => chrome.tabs.ungroup([id]), h1.id);
    await sleep(500);
    await swEval(() => globalThis.__ttForceSettle());
    await ui({ type: "ui:customGroups:set", list: [] }); // bump the generation
    await swEval(() => globalThis.__ttTick({}));
    await sleep(700);
    assert((await getTab(h1.id)).groupId === -1, "hands-off tab left alone by the review");
    // paused: zero moves
    await swEval(() => chrome.storage.session.set({ pausedUntil: Date.now() + 60_000 }));
    const p1 = await openViaCommit(`${baseUrl}/pausedStray1`, { active: false });
    const p2 = await openViaCommit(`${baseUrl}/pausedStray2`, { active: false });
    await swEval(() => globalThis.__ttTick({}));
    await sleep(600);
    assert((await getTab(p1.id)).groupId === -1 && (await getTab(p2.id)).groupId === -1,
      "the review is silent while automation is paused");
    await swEval(() => chrome.storage.session.set({ pausedUntil: 0 }));
  });

  await test("a background review never clobbers the user's undo", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "off" });
    const u1 = await createTab({ url: `${baseUrl}/undoKeepA`, active: false });
    const u2 = await createTab({ url: `${baseUrl}/undoKeepB`, active: false });
    await sleep(500);
    await ui({ type: "ui:organizeNow", scope: "all" });
    const mine = (await ui({ type: "ui:getState" })).lastOrganize;
    assert(mine && mine.gids.length >= 1, "the user's run is remembered");
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" }); // bumps the generation
    await swEval(() => globalThis.__ttTick({}));
    await sleep(700);
    const after = (await ui({ type: "ui:getState" })).lastOrganize;
    assert(
      JSON.stringify(after.gids) === JSON.stringify(mine.gids),
      "the review owns no undo slot - the user's click still does",
    );
  });

  await test("Re-sort on Other: one AI question, asked once", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "builtin" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "topic" });
    await swEval(() => {
      globalThis.__aiCalls = 0;
      globalThis.__ttSetMockAi({
        availability: "available",
        respond: (prompt) => {
          globalThis.__aiCalls++;
          if (prompt.includes("Pick the best topic group")) return JSON.stringify({ group: null });
          const idx = prompt
            .split("\n")
            .filter((line) => /^\d+\. /.test(line))
            .filter((line) => line.includes("catsPage"))
            .map((line) => parseInt(line, 10));
          return idx.length
            ? JSON.stringify({ groups: [{ name: "Cats", tabIndices: idx }] })
            : JSON.stringify({ groups: [] });
        },
      });
    });
    const c1 = await openViaCommit(`${baseUrl}/catsPageOne`, { active: false });
    const c2 = await openViaCommit(`${altUrl}/catsPageTwo`, { active: false });
    await waitFor("parked in Other", async () => (await getTab(c2.id)).groupId !== -1, 8000);
    const otherGid = (await getTab(c2.id)).groupId;
    const winId = (await getTab(c1.id)).windowId;
    // the question nothing else asks: do these strays form a topic TOGETHER?
    const res = await ui({ type: "ui:reviewOther", windowId: winId });
    assert(res.grouped >= 2, `the review pulled them out (${res.grouped})`);
    const gid = (await getTab(c1.id)).groupId;
    assert(gid !== -1 && gid !== otherGid, "they left the parking lot");
    const g = await swEval((id) => chrome.tabGroups.get(id), gid);
    assert(g.title === "Cats", `a real topic (got "${g.title}")`);
    // same pool, same topics: the model is not woken again
    const callsBefore = await swEval(() => globalThis.__aiCalls);
    const again = await ui({ type: "ui:reviewOther", windowId: winId });
    assert(again.grouped === 0, "nothing to do the second time");
    assert(
      (await swEval(() => globalThis.__aiCalls)) === callsBefore,
      "the same question is never asked twice",
    );
    await swEval(() => globalThis.__ttSetMockAi(null));
    await ui({ type: "ui:setSetting", key: "smartEngine", value: "off" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("sortAuto off: a manual drag stays put, Organize still sorts", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "off" });
    await ui({ type: "ui:setSetting", key: "sortTabs", value: "title" });
    await ui({ type: "ui:setSetting", key: "sortAuto", value: false });
    const z = await openViaCommit(`${baseUrl}/zzManual`, { active: false });
    const a = await openViaCommit(`${altUrl}/aaManual`, { active: false });
    const idx = (id) => swEval((tid) => chrome.tabs.get(tid).then((t) => t.index), id);
    await sleep(1200);
    // nothing maintains the order now: drag zz to the front and it stays
    await swEval((tid) => chrome.tabs.move(tid, { index: 0 }), z.id);
    await sleep(1500);
    assert((await idx(z.id)) < (await idx(a.id)), "no snap-back while sortAuto is off");
    // but the button still sorts on demand
    await ui({ type: "ui:organizeNow", scope: "all" });
    await waitFor("Organize applies the order", async () => (await idx(a.id)) < (await idx(z.id)), 5000);
    await ui({ type: "ui:setSetting", key: "sortAuto", value: true });
    await ui({ type: "ui:setSetting", key: "sortTabs", value: "off" });
    await ui({ type: "ui:setSetting", key: "autoGroup", value: "site" });
  });

  await test("service worker: zero unchecked errors across the whole run", async () => {
    await sleep(500);
    assert(
      swErrors.length === 0,
      `sw errors: ${swErrors.slice(0, 3).join(" | ") || "none"}`,
    );
  });

  clearTimeout(globalWatchdog);
  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
