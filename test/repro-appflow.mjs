// Standing repro: tabs an APPLICATION opens (window.open, target=_blank flows,
// OAuth hops, SPA branch links) versus the automation. The customer case that
// started it: ChatGPT's "branch in new chat" opens a tab at
// https://chatgpt.com/c/WEB:<uuid> that then redirects to the real chat, and
// with the extension on the flow dies.
//
// Run: cd test && node repro-appflow.mjs   (HEADFUL=1 to watch)
//
// Each scenario prints what the browser did WITHOUT any simulation: the pages
// are real, the navigations are real, the extension is the live unpacked build.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
let worker;
let base;
let alt; // a second site on the same server: http://localhost:<port>

const swEval = (fn, ...args) => worker.evaluate(fn, ...args);

const tabs = () =>
  swEval(() =>
    chrome.tabs
      .query({})
      .then((list) =>
        list.map((t) => ({ id: t.id, url: t.url || t.pendingUrl || "", groupId: t.groupId })),
      ),
  );

const trace = () => swEval(() => globalThis.__ttDiag.trace.slice(-12));

async function resetWorld() {
  await swEval(async () => {
    const all = await chrome.tabs.query({});
    const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
    if (wins.length) {
      await new Promise((r) =>
        chrome.tabs.create({ url: "about:blank", windowId: wins[0].id, active: true }, () => r()),
      );
    }
    for (const t of all) {
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
      "blankCloseLedger",
      "blankCloseAllowance",
      "pausedUntil",
      "diagTrace",
    ]);
  });
  await swEval(() => {
    globalThis.__ttDiag.trace.length = 0;
    return globalThis.__ttForceSettle();
  });
  await sleep(300);
}

// The pages. /open?to=... carries a real button: window.open under a user
// gesture, exactly like an app's "open in new tab".
function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const html = (body) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset=utf-8><title>${url.pathname}</title>${body}`);
    };
    if (url.pathname === "/open" || url.pathname === "/openbg") {
      const to = url.searchParams.get("to") || "/plain";
      const bg = url.pathname === "/openbg";
      html(`<button id=go>open</button><script>
        document.getElementById('go').onclick = () => {
          const w = window.open(${JSON.stringify(to)}, '_blank');
          ${bg ? "window.focus();" : ""}
        };
      </script>`);
      return;
    }
    // A page that lands, then moves the tab on - the shape of every app hop:
    // OAuth callback, payment return, ChatGPT's WEB:<uuid> placeholder.
    if (url.pathname === "/hop") {
      const to = url.searchParams.get("to");
      const how = url.searchParams.get("how") || "replace"; // replace | assign | history
      const delay = Number(url.searchParams.get("delay") || 250);
      html(`<p>hop</p><script>setTimeout(() => {
        ${
          how === "history"
            ? `history.replaceState({}, '', ${JSON.stringify(to)});`
            : how === "assign"
              ? `location.assign(${JSON.stringify(to)});`
              : `location.replace(${JSON.stringify(to)});`
        }
      }, ${delay});</script>`);
      return;
    }
    if (url.pathname === "/302") {
      res.writeHead(302, { location: url.searchParams.get("to") || "/plain" });
      res.end();
      return;
    }
    html(`<p>${url.pathname}${url.search}</p>`);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const cases = [];
const ONLY = process.env.ONLY || "";
function scenario(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  cases.push({ name, fn });
}

// 1. The plain duplicate the product exists for: the user opens a page that is
//    already open (address bar, bookmark, a link from another app - no opener
//    tab at all). Must still die: this is the feature, and no guard below may
//    weaken it.
scenario("baseline: a user-opened duplicate still collapses", async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/plain`);
  await sleep(600);
  await swEval((u) => chrome.tabs.create({ url: u }), `${base}/plain`);
  await sleep(1500);
  const list = await tabs();
  return `${list.filter((t) => t.url === `${base}/plain`).length} tab(s) on /plain (want 1)`;
});

// 1b. A link opened from ANOTHER site: the opener is not the destination's
//     app, so the duplicate still collapses (127.0.0.1 and localhost are two
//     sites to the engine, one server to the test).
scenario("baseline: a cross-site opener does not shield a duplicate", async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/plain`);
  await sleep(600);
  const opener = await browser.newPage();
  await opener.goto(`${alt}/open?to=${encodeURIComponent(`${base}/plain`)}`);
  await sleep(400);
  await opener.click("#go");
  await sleep(1500);
  const list = await tabs();
  return `${list.filter((t) => t.url === `${base}/plain`).length} tab(s) on /plain (want 1)`;
});

// 2. The app flow: a script-opened tab that redirects onward. The intermediate
//    url is unique, so dedup has no reason to fire - this proves the flow
//    survives the rest of the machinery (grouping, sorting, blank sweep).
scenario("app flow: window.open -> client redirect reaches its destination", async () => {
  const opener = await browser.newPage();
  const target = `${base}/hop?to=${encodeURIComponent("/dest-a")}&how=replace`;
  await opener.goto(`${base}/open?to=${encodeURIComponent(target)}`);
  await sleep(400);
  await opener.click("#go");
  await sleep(2000);
  const list = await tabs();
  const landed = list.filter((t) => t.url.includes("/dest-a"));
  return `${landed.length} tab(s) landed on /dest-a (want 1)`;
});

// 3. The ChatGPT shape: the app opens a placeholder url, the SPA swaps it for
//    the real one via history.replaceState (no commit at all).
scenario("app flow: placeholder url swapped by replaceState survives", async () => {
  const opener = await browser.newPage();
  const target = `${base}/hop?to=${encodeURIComponent("/c/REAL-1")}&how=history`;
  await opener.goto(`${base}/open?to=${encodeURIComponent(target)}`);
  await sleep(400);
  await opener.click("#go");
  await sleep(2000);
  const list = await tabs();
  const landed = list.filter((t) => t.url.includes("/c/REAL-1"));
  return `${landed.length} tab(s) on /c/REAL-1 (want 1)`;
});

// 4. The suspected killer: the app opens a tab whose FIRST url matches a page
//    already open. On the commit path this is auto_toplevel - never a victim.
//    Pre-commit dedup has no classification, so it may kill the flow before
//    the app ever runs.
scenario("app flow: script-opened tab whose first url is already open", async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/hop?to=${encodeURIComponent("/dest-b")}&how=replace&delay=100000`);
  await sleep(500);
  const opener = await browser.newPage();
  const target = `${base}/hop?to=${encodeURIComponent("/dest-b")}&how=replace&delay=100000`;
  await opener.goto(`${base}/open?to=${encodeURIComponent(target)}`);
  await sleep(400);
  await opener.click("#go");
  await sleep(1500);
  const list = await tabs();
  const hops = list.filter((t) => t.url.includes("/hop"));
  const t = (await trace()).filter((line) => /dedup|blank/.test(line));
  return `${hops.length} tab(s) on the flow url (2 = flow survived, 1 = killed) | trace: ${t.join(" ; ") || "-"}`;
});

// 5. OAuth shape: the flow tab is opened by script and hops twice through a
//    url the user already has open (the provider's consent screen).
scenario("oauth shape: consent url already open elsewhere", async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/auth?client=x`);
  await sleep(400);
  const opener = await browser.newPage();
  const target = `${base}/auth?client=x`;
  await opener.goto(`${base}/open?to=${encodeURIComponent(target)}`);
  await sleep(400);
  await opener.click("#go");
  await sleep(1500);
  const list = await tabs();
  const auth = list.filter((t) => t.url.includes("/auth"));
  const t = (await trace()).filter((line) => /dedup|blank|merge/.test(line));
  return `${auth.length} tab(s) on /auth (2 = login flow survived, 1 = killed) | trace: ${t.join(" ; ") || "-"}`;
});

// 7. The app opens its flow tab in the BACKGROUND (the user keeps working in
//    the opener) - the blank sweep and the archive both look at background
//    tabs differently.
scenario("app flow: background tab opened by script", async () => {
  const opener = await browser.newPage();
  await opener.goto(`${base}/openbg?to=${encodeURIComponent(`${base}/hop?to=%2Fdest-d&delay=400`)}`);
  await sleep(400);
  await opener.click("#go");
  await sleep(2000);
  const list = await tabs();
  return `${list.filter((t) => t.url.includes("/dest-d")).length} tab(s) on /dest-d (want 1)`;
});

// 8. A SLOW flow: the placeholder sits for 3s before the app moves it on (a
//    real branch/checkout call takes that long).
scenario("app flow: slow hop (3s) still lands", async () => {
  const opener = await browser.newPage();
  const target = `${base}/hop?to=${encodeURIComponent("/dest-e")}&delay=3000`;
  await opener.goto(`${base}/open?to=${encodeURIComponent(target)}`);
  await sleep(400);
  await opener.click("#go");
  await sleep(5000);
  const list = await tabs();
  return `${list.filter((t) => t.url.includes("/dest-e")).length} tab(s) on /dest-e (want 1)`;
});

// 9. The flow ENDS on a url the user already has open (a branch that lands on
//    an already-open chat, a checkout that returns to an open order page).
scenario("app flow: destination already open elsewhere", async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/dest-f`);
  await sleep(400);
  const opener = await browser.newPage();
  const target = `${base}/hop?to=${encodeURIComponent("/dest-f")}&delay=400`;
  await opener.goto(`${base}/open?to=${encodeURIComponent(target)}`);
  await sleep(400);
  await opener.click("#go");
  await sleep(2000);
  const list = await tabs();
  const t = (await trace()).filter((line) => /dedup|blank|merge/.test(line));
  return `${list.filter((t) => t.url.includes("/dest-f")).length} tab(s) on /dest-f (1 = merged, 2 = both) | trace: ${t.join(" ; ") || "-"}`;
});

// 6. Server redirect through an already-open url: /302?to=/plain with /plain
//    open. The chain is server-side, so the victim url never commits.
scenario("server redirect through an open url", async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/plain`);
  await sleep(400);
  const opener = await browser.newPage();
  const target = `${base}/302?to=${encodeURIComponent("/dest-c")}`;
  await opener.goto(`${base}/open?to=${encodeURIComponent(target)}`);
  await sleep(400);
  await opener.click("#go");
  await sleep(1500);
  const list = await tabs();
  return `${list.filter((t) => t.url.includes("/dest-c")).length} tab(s) on /dest-c (want 1)`;
});

async function main() {
  const server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
  alt = `http://localhost:${server.address().port}`;
  browser = await puppeteer.launch({
    headless: !process.env.HEADFUL,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  const target = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().endsWith("background.js"),
    { timeout: 20_000 },
  );
  worker = await target.worker();

  for (const c of cases) {
    await resetWorld();
    let out;
    try {
      out = await c.fn();
    } catch (err) {
      out = `ERROR ${err.message}`;
    }
    console.log(`- ${c.name}\n    ${out}`);
  }

  await browser.close();
  server.close();
}

main();
