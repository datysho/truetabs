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

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
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

async function test(name, fn) {
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
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><title>page-${name}</title></head>` +
        `<body style="height:100vh;margin:0">page ${name}</body></html>`,
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ------------------------------------------------------------------ tests
async function main() {
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
    assert(state.settings.groupAuto === true, "groupAuto default on");
    assert(state.settings.smartEngine === "off", "smart off by default");
    assert(state.settings.sortMode === "off", "sort off by default");
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
    await ui({ type: "ui:setSetting", key: "groupAuto", value: false });
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
    await ui({ type: "ui:setSetting", key: "groupAuto", value: true });
  });

  await test("restart: reload re-adopts domain groups by 3-of-3 signature", async () => {
    await resetWorld();
    await ui({ type: "ui:setSetting", key: "groupAuto", value: true });
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
    await ui({ type: "ui:setSetting", key: "groupAuto", value: false });
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
    await ui({ type: "ui:setSetting", key: "groupAuto", value: true });
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
    await ui({ type: "ui:setSetting", key: "sortMode", value: "title" });
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
    await ui({ type: "ui:setSetting", key: "sortMode", value: "off" });
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
    await ui({ type: "ui:setSetting", key: "groupAuto", value: false });
    const loose1 = await openViaCommit(`${baseUrl}/looseFirst`, { active: false });
    const g1 = await openViaCommit(`${altUrl}/topA`, { active: false });
    const g2 = await openViaCommit(`${altUrl}/topB`, { active: false });
    await ui({ type: "ui:setSetting", key: "groupAuto", value: true });
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
    await ui({ type: "ui:setSetting", key: "groupAuto", value: false });
    const t1 = await createTab({ url: `${baseUrl}/themeA1` });
    const t2 = await createTab({ url: `${altUrl}/themeA2` });
    const o1 = await createTab({ url: `${baseUrl}/leftover1` });
    const o2 = await createTab({ url: `${altUrl}/leftover2` });
    await sleep(400);
    await swEval(() =>
      globalThis.__ttSetMockAi({
        availability: "available",
        respond: () => JSON.stringify({ groups: [{ name: "Theme", tabIndices: [0, 1] }] }),
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
    await ui({ type: "ui:setSetting", key: "groupAuto", value: true });
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
