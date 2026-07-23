// Standalone probe: what does TrueTabs do when a Document Picture-in-Picture
// window is open? Google Meet opens one by itself when the user leaves the
// call tab while somebody presents - so it appears mid-call, unasked.
//
// The platform quirk is established (TruePin v3.15.6, Chrome 148): Chrome
// reports such a window as type "normal" - in windows.onCreated and in
// windows.getAll({windowTypes:["normal"]}) alike - and it hosts no tab strip.
// TrueTabs asks `win.type !== "normal"` in a dozen places and never looks at
// alwaysOnTop, so the questions here are TrueTabs' own:
//
//   1. Does the PiP window enter normalWindows() - the tab universe of every
//      sweep, the organize target list, the popup's window count?
//   2. Does it CARRY a tab (chrome.tabs.query)? If yes, that tab is fair game
//      for grouping, dedup, the archive sweep and cross-window moves.
//   3. Does anything actually land in it: a group created there, tabs moved
//      or grouped into it, the "Other" catch-all aiming at it?
//   4. Do the explicit user commands (Organize, Merge windows, sort re-assert,
//      the minute tick) damage anything while it is open?
//
// Run: node repro-pip-window.mjs   (HEADFUL=1 to watch)
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const name = req.url.replace(/\W/g, "") || "index";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><title>page-${name}</title>` +
      `<body style="height:100vh;margin:0">page ${name}` +
      `<script>
         document.body.addEventListener("click", async () => {
           try {
             const w = await documentPictureInPicture.requestWindow({width: 320, height: 200});
             w.document.body.textContent = "meet mini window";
             window.__pipOk = true;
           } catch (e) { window.__pipErr = String(e); }
         });
       </script>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const alt = `http://localhost:${port}`; // a second "site" so two groups form

const browser = await puppeteer.launch({
  headless: !process.env.HEADFUL,
  args: [
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const target = await browser.waitForTarget(
  (t) => t.type() === "service_worker" && t.url().endsWith("background.js"),
  { timeout: 20_000 },
);
const worker = await target.worker();
const swEval = (fn, ...a) => worker.evaluate(fn, ...a);
const ui = (request) => swEval((r) => globalThis.__ttUiCall(r), request);

async function waitFor(label, probe, ms = 15000, iv = 250) {
  const start = Date.now();
  for (;;) {
    if (await probe()) return true;
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await sleep(iv);
  }
}

// Everything the engine's window predicate could disagree about, in one dump.
const worldDump = () =>
  swEval(async () => {
    const all = await chrome.windows.getAll({ populate: true });
    const normalIds = (await chrome.windows.getAll({ windowTypes: ["normal"] })).map((w) => w.id);
    const groups = (await chrome.tabGroups.query({})) || [];
    return {
      windows: all.map((w) => ({
        id: w.id,
        type: w.type,
        alwaysOnTop: w.alwaysOnTop,
        incognito: w.incognito,
        tabs: (w.tabs || []).map((t) => ({ id: t.id, url: t.url, groupId: t.groupId })),
      })),
      normalIds,
      groups: groups.map((g) => ({ id: g.id, title: g.title, windowId: g.windowId })),
      tabsByWindow: (await chrome.tabs.query({})).reduce((acc, t) => {
        acc[t.windowId] = (acc[t.windowId] || 0) + 1;
        return acc;
      }, {}),
    };
  });

const brief = (d) =>
  d.windows
    .map(
      (w) =>
        `win ${w.id} type=${w.type} aot=${w.alwaysOnTop} tabs=${w.tabs.length}` +
        (d.normalIds.includes(w.id) ? " [counted normal]" : ""),
    )
    .join("\n     ");

let failed = false;
const findings = [];
try {
  await swEval(() => globalThis.__ttForceSettle());
  await sleep(300);

  console.log("== setup: one window, two site groups, layout invariants on ==");
  for (const [k, v] of Object.entries({
    autoGroup: "site",
    otherGroup: true,
    groupsOnTop: true,
    sortGroups: "title",
    sortTabs: "title",
    sortAuto: true,
    dedupAuto: true,
    archiveAfter: "6h",
  })) {
    await ui({ type: "ui:setSetting", key: k, value: v });
  }

  const mainId = await swEval(
    async (args) => {
      const w = await chrome.windows.create({ url: args.base + "/alpha1" });
      for (const u of [
        args.base + "/alpha2",
        args.base + "/alpha3",
        args.alt + "/beta1",
        args.alt + "/beta2",
        args.alt + "/beta3",
      ]) {
        const t = await chrome.tabs.create({ windowId: w.id, url: "about:blank", active: false });
        await chrome.tabs.update(t.id, { url: u });
        await new Promise((r) => setTimeout(r, 500));
      }
      return w.id;
    },
    { base, alt },
  );
  await sleep(3000);
  await ui({ type: "ui:organizeNow", scope: "all", windowId: mainId });
  await sleep(1500);

  const before = await worldDump();
  const stateBefore = await ui({ type: "ui:getState" });
  console.log("     " + brief(before));
  console.log(`     groups: ${JSON.stringify(before.groups)}`);
  console.log(
    `     popup counts: tabs=${stateBefore.counts.tabs} windows=${stateBefore.counts.windows}`,
  );

  console.log("\n== the call's mini window opens (Document Picture-in-Picture) ==");
  const pages = await browser.pages();
  const page = pages.find((p) => p.url().includes("/alpha1")) || pages[pages.length - 1];
  await page.bringToFront();
  await page.click("body");
  await sleep(1500);
  const pipState = await page.evaluate(() => ({
    ok: !!window.__pipOk,
    err: window.__pipErr || null,
  }));
  console.log("     requestWindow:", JSON.stringify(pipState));
  if (!pipState.ok) {
    console.log("     PiP did not open here - probe INCONCLUSIVE (try HEADFUL=1)");
    throw new Error("no PiP window");
  }

  const afterOpen = await worldDump();
  const pipWin = afterOpen.windows.find((w) => !before.windows.some((b) => b.id === w.id));
  if (!pipWin) throw new Error("PiP window not visible to the windows API at all");
  console.log("     " + brief(afterOpen));
  console.log(
    `\n  Q1 does it enter normalWindows()? ${
      afterOpen.normalIds.includes(pipWin.id) ? "YES - type " + pipWin.type : "no"
    } (alwaysOnTop=${pipWin.alwaysOnTop})`,
  );
  console.log(`  Q2 does it carry a tab? ${pipWin.tabs.length ? "YES" : "no"} (${pipWin.tabs.length})`);

  // Let the passive engine react (window-created paths, review, sort assert).
  await sleep(5000);

  // What "untouched" means: the overlay keeps exactly the tab Chrome put in
  // it (that tab IS the mini window - losing it destroys the overlay), gains
  // none of ours, grows no group, and never enters the popup's counts.
  const ownTabs = pipWin.tabs.map((t) => t.id).sort().join(",");
  const baseline = stateBefore.counts;

  const check = async (label) => {
    const d = await worldDump();
    const st = await ui({ type: "ui:getState" });
    const pip = d.windows.find((w) => w.id === pipWin.id);
    const groupsInPip = d.groups.filter((g) => g.windowId === pipWin.id);
    const mainTabs = (d.windows.find((w) => w.id === mainId) || { tabs: [] }).tabs.length;
    const nowTabs = pip ? pip.tabs.map((t) => t.id).sort().join(",") : "";
    console.log(
      `  ${label}: pip ${pip ? `alive tabs=[${nowTabs}]` : "GONE"}` +
        `, groups in pip=${groupsInPip.length}` +
        `, main tabs=${mainTabs}, popup windows=${st.counts.windows}, popup tabs=${st.counts.tabs}`,
    );
    if (!pip) findings.push(`${label}: the mini window was DESTROYED`);
    else if (nowTabs !== ownTabs) {
      findings.push(`${label}: its tabs changed [${ownTabs}] -> [${nowTabs}]`);
    }
    if (groupsInPip.length) findings.push(`${label}: a tab group was created in the mini window`);
    if (st.counts.windows > baseline.windows) {
      findings.push(`${label}: popup counts the overlay as a window (${st.counts.windows})`);
    }
    if (st.counts.tabs > baseline.tabs) {
      findings.push(`${label}: popup counts the overlay's tab (${st.counts.tabs})`);
    }
    return { d, st };
  };

  console.log("\n== what the engine does with it ==");
  await check("idle (passive)");

  await ui({ type: "ui:organizeNow", scope: "all", windowId: mainId });
  await sleep(2000);
  await check("after Organize (all windows)");

  await ui({ type: "ui:setSetting", key: "sortGroups", value: "recent" });
  await sleep(2000);
  await check("after sort re-assert");

  await swEval((t) => globalThis.__ttTick({ now: t }), Date.now() + 7 * 3600e3);
  await sleep(2500);
  await check("after minute tick (+7h: archive sweep)");

  const merge = await ui({ type: "ui:mergeWindows", targetWindowId: mainId });
  await sleep(2000);
  await check("after Merge windows");
  // The counts below are about REAL windows only - an overlay is not merge
  // material, so it may appear in neither "moved" nor "emptied".
  console.log(`     merge reported: ${JSON.stringify(merge)}`);

  // Is the PiP document still alive and showing what Meet put in it?
  const pipAlive = await page.evaluate(
    () => !!(window.documentPictureInPicture && documentPictureInPicture.window),
  );
  console.log(`\n  PiP document still alive in the page: ${pipAlive}`);
  if (!pipAlive) findings.push("the PiP document was torn down while TrueTabs worked");

  console.log("\n  trace:", JSON.stringify(await swEval(() => globalThis.__ttDiag.trace.slice(-18)), null, 1));

  if (findings.length) {
    console.log(`\nFAIL  ${findings.length} finding(s):`);
    for (const f of findings) console.log(`  - ${f}`);
    failed = true;
  } else {
    console.log("\nPASS  nothing of TrueTabs' reaches the PiP window");
  }
} catch (e) {
  console.error("REPRO ERROR:", e.message);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exitCode = failed ? 1 : 0;
