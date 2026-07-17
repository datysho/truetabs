// TrueTabs - service worker. An invisible tab-lifecycle butler:
//   1) a URL you already have open never opens twice - the new tab closes
//      itself and the existing one is focused (Arc-style dedup),
//   2) tabs untouched for X hours are archived: saved locally, closed,
//      undoable in one click (Arc-style cleanup),
//   3) tabs are grouped by site with stable colors, idle groups collapse;
//      an optional AI engine (on-device Gemini Nano or the user's own API
//      key) organizes tabs by TOPIC instead of site,
//   4) one popup with live counts and one-click actions.
//
// Safety canon (TruePin lineage):
//   - serialized mutation queue: every state change runs FIFO, no races;
//   - settle-then-act: zero automation until the browser session is calm
//     after a cold start (session restore looks like a duplicate storm);
//   - selfClosed markers so our own closes are never misread;
//   - circuit breakers with declared allowances on closes AND creates:
//     runaway automation stalls and reports itself, never runs silent;
//   - two-strikes anti-fight ledger: an automatic action counteracted twice
//     (by the user or another extension) retires that action class for that
//     key until the browser restarts - no extension wars, ever;
//   - pinned tabs are NEVER closed, moved, grouped or archived (TruePin
//     territory: it resurrects and mirrors them); a pinned tab may only be
//     the focus target of a dedup;
//   - foreign tab groups (made by the user or another extension) are never
//     modified; only groups this extension created are managed.
//
// Persistent truth: settings in storage.sync; the archive, counters and
// group signatures in storage.local. Everything per-tab/per-group is in
// storage.session - it survives service worker suspension and resets with
// tab ids on browser restart.

importScripts("i18n.js");
importScripts("config.js");

// --- constants & defaults --------------------------------------------------

const DEFAULTS = {
  // pillar 1 - duplicates
  dedupAuto: true, // close-into-focus on duplicate open
  dedupScope: "window", // "window" | "all" - where the existing copy may live
  // pillar 2 - archive
  archiveAfter: "24h", // "6h" | "12h" | "24h" | "3d" | "7d" | "off"
  archiveTtl: "30d", // "7d" | "30d" | "90d" | "forever"
  archiveForeignGroups: false, // user-made groups are curated intent: skip
  archiveNotify: true, // notification with Undo per auto-batch
  discardStale: false, // free memory at half-threshold (Chrome has Memory Saver)
  archiveAllowlist: ["meet.google.com", "zoom.us", "teams.microsoft.com"],
  // pillar 3 - groups
  autoGroup: "site", // "off" | "site" | "topic" - how NEW tabs are grouped on first commit
  groupCollapseAfter: "10m", // "off" | "5m" | "10m" | "30m"
  sortGroups: "off", // "off" | "title" | "recent" | "opened" | "live" - group order
  sortTabs: "off", // same values - tab order (loose + inside our groups); live = active surfaces
  groupsOnTop: false, // keep groups at the front of the strip (applied on Organize + new groups)
  // pillar 3b - smart (AI) grouping
  smartEngine: "off", // "off" | "builtin" | "byok"
  smartOther: true, // collect unassigned tabs into an "Other" group, always last
  smartRegroupOurs: true, // Smart Organize may rebuild OUR auto groups (hand-made never)
  byokProvider: "openai", // "openai" | "gemini" | "grok" | "custom"
  byokModel: "",
  byokBaseUrl: "", // custom OpenAI-compatible endpoint (Ollama, LM Studio)
  // shell
  theme: "auto", // "auto" | "light" | "dark"
  iconStyle: "color", // "color" | "mono" - match the browser UI (TruePin parity)
  language: "auto",
};

const AFTER_MS = {
  "6h": 6 * 3600e3,
  "12h": 12 * 3600e3,
  "24h": 24 * 3600e3,
  "3d": 3 * 86400e3,
  "7d": 7 * 86400e3,
};
const TTL_MS = { "7d": 7 * 86400e3, "30d": 30 * 86400e3, "90d": 90 * 86400e3 };
const COLLAPSE_MS = { "5m": 5 * 60e3, "10m": 10 * 60e3, "30m": 30 * 60e3 };

const TICK_ALARM = "tt-tick"; // 1-minute heartbeat: stale scan, collapse, prune
// Settle gate: the tab count must hold still across this many polls...
const SETTLE_CALM_POLLS = 3;
const SETTLE_POLL_MS = 300; // ...this far apart (max 40 attempts),
const SETTLE_MIN_MS = 15_000; // and this much wall-clock must pass after a cold start.
const CLOSE_WINDOW_MS = 60_000; // close breaker sliding window
const CLOSE_BURST = 25; // base automatic-close budget per sliding window
const CREATE_WINDOW_MS = 60_000;
const CREATE_BURST = 25; // restore/undo creation budget (TruePin guardedCreate mirror)
const PAUSE_ON_TRIP_MS = 10 * 60_000; // breaker trip pauses ALL automation
const BREAKER_RENOTIFY_MS = 5 * 60_000;
const SELF_CLOSED_TTL_MS = 60_000;
const SELF_OP_TTL_MS = 4_000; // our own group/tab mutations, so listeners skip them
const STRIKE_WINDOW_MS = 60_000; // counteraction this soon after our act = a strike
const STRIKE_LIMIT = 2;
const FRESH_COMMIT_LIMIT = 1; // dedup victims: only a tab's FIRST committed page
const ARCHIVE_CAP = 5000; // FIFO
const ARCHIVE_BATCH_MAX = 20; // per tick - gradual, keeps notifications sane
const SIG_TTL_MS = 30 * 86400e3; // group signatures wait this long for their window
const SMART_BATCH = 15; // tabs per AI call: finer progress, themes still merge across batches

const TRACKING_PARAMS = /^(utm_|__hs|_hs)/;
const TRACKING_EXACT = new Set([
  "fbclid", "gclid", "gclsrc", "dclid", "msclkid", "yclid", "twclid",
  "ttclid", "igshid", "mc_cid", "mc_eid", "vero_id", "wickedid",
  "oly_enc_id", "oly_anon_id", "s_kwcid", "ref_src",
]);
const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

// --- serialized state mutations ---------------------------------------------
// Every mutation of shared state runs through this FIFO queue: concurrent
// read-modify-writes of one storage key are how markers get lost (TruePin's
// selfClosed race). Event handlers and ui:* calls only enqueue jobs.

let queueTail = Promise.resolve();
globalThis.__ttDiag = { queued: 0, finished: 0, last: "", trace: [] };
function traceDiag(entry) {
  globalThis.__ttDiag.trace.push(`${new Date().toISOString().slice(11, 19)} ${entry}`);
  if (globalThis.__ttDiag.trace.length > 40) globalThis.__ttDiag.trace.shift();
}
function enqueue(job, label = "job") {
  globalThis.__ttDiag.queued++;
  const run = queueTail.then(() => {
    globalThis.__ttDiag.last = `${label} started`;
    return job();
  });
  queueTail = run.then(
    () => {
      globalThis.__ttDiag.finished++;
      globalThis.__ttDiag.last = `${label} finished`;
    },
    (err) => {
      globalThis.__ttDiag.finished++;
      globalThis.__ttDiag.last = `${label} failed: ${err && err.message}`;
      console.warn("[truetabs]", err);
    },
  );
  return run;
}

// Time source: tests drive the production scan with a clock override.
let clockOverride = null;
const now = () => clockOverride ?? Date.now();

// Every stored value is validated against DEFAULTS on EVERY read: an update
// must survive whatever an older version (or a sync conflict) left behind -
// wrong types, retired keys, unknown enum values. Old keys are mapped to
// their successors first, so an upgrade carries the user's choices over.
const SETTING_ENUMS = {
  dedupScope: ["window", "all"],
  archiveAfter: ["6h", "12h", "24h", "3d", "7d", "off"],
  archiveTtl: ["7d", "30d", "90d", "forever"],
  autoGroup: ["off", "site", "topic"],
  groupCollapseAfter: ["off", "5m", "10m", "30m"],
  sortGroups: ["off", "title", "recent", "opened", "live"],
  sortTabs: ["off", "title", "recent", "opened", "live"],
  smartEngine: ["off", "builtin", "byok"],
  byokProvider: ["openai", "gemini", "grok", "custom"],
  theme: ["auto", "light", "dark"],
  iconStyle: ["color", "mono"],
};

function normalizeSettings(raw) {
  const src = raw && typeof raw === "object" ? { ...raw } : {};
  // v1.3 -> v1.4 renames (idempotent: old keys only apply while new ones are absent).
  if (!("autoGroup" in src)) {
    if (src.groupAuto === false) src.autoGroup = "off";
    else if (src.smartAutoAssign === true && src.smartEngine && src.smartEngine !== "off") {
      src.autoGroup = "topic";
    }
  }
  if (!("sortTabs" in src) && typeof src.sortMode === "string") src.sortTabs = src.sortMode;
  if (!("sortGroups" in src) && typeof src.sortMode === "string") src.sortGroups = src.sortMode;
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = src[key];
    const def = DEFAULTS[key];
    if (typeof def === "boolean") {
      if (typeof value === "boolean") out[key] = value;
    } else if (Array.isArray(def)) {
      if (Array.isArray(value)) {
        out[key] = value.filter((v) => typeof v === "string").slice(0, 200);
      }
    } else if (SETTING_ENUMS[key]) {
      if (SETTING_ENUMS[key].includes(value)) out[key] = value;
    } else if (typeof value === "string") {
      out[key] = value.slice(0, 500);
    }
  }
  return out;
}

async function getSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return normalizeSettings(settings);
}

// --- custom groups (user rules) ----------------------------------------------
// The user's own named groups with routing rules: a domain list (deterministic,
// runs before any automatic grouping) and/or an AI hint (used by topic mode and
// Smart Organize). Stored under their own sync key with hard caps - sync gives
// one item ~8KB and rules must never be the thing that breaks saving settings.
const CUSTOM_CAPS = { groups: 10, name: 40, domains: 12, domain: 60, hint: 140 };

function normalizeCustomGroups(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const g of raw.slice(0, CUSTOM_CAPS.groups)) {
    if (!g || typeof g !== "object" || typeof g.name !== "string") continue;
    const name = g.name.trim().slice(0, CUSTOM_CAPS.name);
    if (!name) continue;
    const domains = (Array.isArray(g.domains) ? g.domains : [])
      .filter((d) => typeof d === "string")
      .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
      .filter(Boolean)
      .slice(0, CUSTOM_CAPS.domains)
      .map((d) => d.slice(0, CUSTOM_CAPS.domain));
    out.push({
      id: typeof g.id === "string" && g.id ? g.id.slice(0, 40) : `c${fnv1a32(name)}`,
      name,
      color: GROUP_COLORS.includes(g.color) ? g.color : colorFor(name),
      domains,
      hint: typeof g.hint === "string" ? g.hint.trim().slice(0, CUSTOM_CAPS.hint) : "",
      on: g.on !== false,
    });
  }
  return out;
}

async function getCustomGroups() {
  const { customGroups } = await chrome.storage.sync.get("customGroups");
  return normalizeCustomGroups(customGroups);
}

function customRuleFor(customs, url) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  const reg = registrableDomain(url);
  for (const c of customs) {
    if (!c.on) continue;
    for (const d of c.domains) {
      if (host === d || host.endsWith(`.${d}`) || reg === d) return c;
    }
  }
  return null;
}

const archiveAfterMs = (settings) => AFTER_MS[settings.archiveAfter] || null;
const archiveTtlMs = (settings) => TTL_MS[settings.archiveTtl] || null;
const collapseAfterMs = (settings) => COLLAPSE_MS[settings.groupCollapseAfter] || null;

// --- i18n --------------------------------------------------------------------
let i18nReady = null;
function ensureI18n() {
  i18nReady ??= getSettings().then((settings) => ttI18n.init(settings.language));
  return i18nReady;
}

// --- quiet chrome.* calls ------------------------------------------------------
// Fire-and-forget calls often target a tab that is mid-close; the callback form
// with an explicit lastError read is the only way Chromium stays quiet about it.
const checked = () => void chrome.runtime.lastError;
const quiet = (api, ...args) =>
  new Promise((resolve) =>
    api(...args, (result) => {
      void chrome.runtime.lastError;
      resolve(result);
    }),
  );

// --- url identity ----------------------------------------------------------------

// Ephemeral pages are not content: blank tabs and the new-tab page across
// Chromium browsers. They never dedup, archive or group.
function isEphemeralUrl(url) {
  if (!url) return true;
  if (/^about:(blank|newtab)$/i.test(url)) return true;
  if (
    /^(chrome|edge|opera|vivaldi|brave):\/\/(newtab|new-tab-page|new-tab-page-third-party|startpage)\/?([?#].*)?$/i.test(
      url,
    )
  ) {
    return true;
  }
  if (/^https:\/\/ntp\.msn\.com\//i.test(url)) return true; // Edge's NTP
  return /^chrome:\/\/vivaldi-webui\/startpage/i.test(url); // Vivaldi's NTP
}

// One normalized string per "same page": host case and default port folded,
// trailing slash stripped, query kept but sorted with tracking params removed
// (?v= on youtube stays significant), hash kept only for SPA hash-routing.
// null = this url never participates (non-http, ephemeral, unparsable).
function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (isEphemeralUrl(raw)) return null;
  const host = u.hostname.toLowerCase();
  const defaultPort =
    (u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443");
  const port = u.port && !defaultPort ? `:${u.port}` : "";
  let path = u.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const params = [...u.searchParams.entries()].filter(
    ([k]) => !TRACKING_PARAMS.test(k) && !TRACKING_EXACT.has(k),
  );
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
  const hash = /^#(\/|!)/.test(u.hash) ? u.hash : "";
  return `${u.protocol}//${host}${port}${path}${query}${hash}`;
}

const dupeKey = normalizeUrl;

// eTLD+1 approximation (TruePin's): last two labels, three when the middle one
// is a known second-level domain; IP literals whole; www. stripped.
const KNOWN_SLD = new Set(["co", "com", "net", "org", "gov", "ac", "edu"]);
function registrableDomain(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
  host = host.replace(/^www\./, "");
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const take = KNOWN_SLD.has(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-take).join(".");
}

// "github.com" -> "Github": a group label, not a hostname fragment.
function cleanLabel(domain) {
  const first = domain.split(".")[0] || domain;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const colorFor = (name) => GROUP_COLORS[fnv1a32(name) % GROUP_COLORS.length];

const tabUrl = (tab) => (tab && (tab.url || tab.pendingUrl)) || "";

// --- per-tab session state --------------------------------------------------------
// t<id>: { firstSeenAt, committedCount, url, key, domain,
//          groupedByUs: gid|null, ungroupedByUser: bool }

const stateKey = (tabId) => `t${tabId}`;

async function getTabState(tabId) {
  const record = await chrome.storage.session.get(stateKey(tabId));
  return record[stateKey(tabId)] || null;
}

function newTabState(tab) {
  return {
    firstSeenAt: now(),
    committedCount: 0,
    url: tabUrl(tab),
    key: dupeKey(tabUrl(tab)),
    domain: registrableDomain(tabUrl(tab)),
    groupedByUs: null,
    ungroupedByUser: false,
  };
}

async function putTabState(tabId, state) {
  await chrome.storage.session.set({ [stateKey(tabId)]: state });
}

async function dropTabState(tabId) {
  await chrome.storage.session.remove(stateKey(tabId));
}

async function normalWindows() {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  return windows.filter((w) => !w.incognito);
}

async function normalTabs(scopeWindowId = null) {
  const wins = await normalWindows();
  const ids = new Set(wins.map((w) => w.id));
  const tabs = await chrome.tabs.query({});
  return tabs.filter(
    (t) =>
      !t.incognito &&
      ids.has(t.windowId) &&
      (scopeWindowId == null || t.windowId === scopeWindowId),
  );
}

// --- settle gate -----------------------------------------------------------------
// After a cold start the browser restores its session in waves that look
// exactly like a duplicate storm. Nothing automatic runs until the tab count
// holds still and a minimum wall-clock has passed (TruePin's calm-wait).

async function isSettled() {
  const { settled, sessionStartedAt = 0 } = await chrome.storage.session.get([
    "settled",
    "sessionStartedAt",
  ]);
  return !!settled && now() - sessionStartedAt >= SETTLE_MIN_MS;
}

function ensureSettleBootstrap() {
  enqueue(async () => {
    const { settled } = await chrome.storage.session.get("settled");
    if (settled) return; // SW wake mid-session: the gate stays passed
    const { sessionStartedAt } = await chrome.storage.session.get("sessionStartedAt");
    if (!sessionStartedAt) {
      await chrome.storage.session.set({ sessionStartedAt: Date.now() });
    }
    let calm = 0;
    let lastCount = -1;
    for (let attempt = 0; attempt < 40 && calm < SETTLE_CALM_POLLS; attempt++) {
      const tabs = await chrome.tabs.query({});
      calm = tabs.length === lastCount && tabs.length > 0 ? calm + 1 : 1;
      lastCount = tabs.length;
      if (calm < SETTLE_CALM_POLLS) {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      }
    }
    // Seed per-tab state for everything already open (no actions taken):
    // archive clocks start from "seen now", never from a guessed past.
    for (const tab of await chrome.tabs.query({})) {
      if (!(await getTabState(tab.id))) await putTabState(tab.id, newTabState(tab));
    }
    await readoptGroups();
    await chrome.storage.session.set({ settled: true });
    traceDiag(`settled at ${lastCount} tabs`);
  }, "settle");
}

// --- selfClosed / self-op markers ---------------------------------------------------

async function markSelfClosed(tabIds) {
  const { selfClosed = {} } = await chrome.storage.session.get("selfClosed");
  const at = now();
  for (const id of tabIds) selfClosed[id] = at;
  for (const [id, ts] of Object.entries(selfClosed)) {
    if (at - ts > SELF_CLOSED_TTL_MS) delete selfClosed[id];
  }
  await chrome.storage.session.set({ selfClosed });
}

async function wasSelfClosed(tabId) {
  const { selfClosed = {} } = await chrome.storage.session.get("selfClosed");
  return selfClosed[tabId] != null && now() - selfClosed[tabId] <= SELF_CLOSED_TTL_MS;
}

// Group/tab mutations we make ourselves, so tabGroups.onUpdated /
// tabs.onUpdated(groupId) never read them as user counteraction.
async function markSelfOp(kind, id) {
  const { selfOps = {} } = await chrome.storage.session.get("selfOps");
  selfOps[`${kind}:${id}`] = now();
  await chrome.storage.session.set({ selfOps });
}

// Peek: is there a fresh marker? (creation checks - a tab we created stays
// exempt from dedup for the TTL, however many commits it makes).
async function wasSelfOp(kind, id) {
  const { selfOps = {} } = await chrome.storage.session.get("selfOps");
  const ts = selfOps[`${kind}:${id}`];
  return ts != null && now() - ts <= SELF_OP_TTL_MS;
}

// Consume: one marker covers exactly ONE observed event. Group listeners use
// this - a user edit arriving right after our own op must still read as the
// user's, so the marker dies with the event our op generated.
async function consumeSelfOp(kind, id) {
  const { selfOps = {} } = await chrome.storage.session.get("selfOps");
  const key = `${kind}:${id}`;
  const ts = selfOps[key];
  const fresh = ts != null && now() - ts <= SELF_OP_TTL_MS;
  if (ts != null) {
    delete selfOps[key];
    await chrome.storage.session.set({ selfOps });
  }
  return fresh;
}

// --- circuit breakers -----------------------------------------------------------
// All automatic closes and creates pass a sliding-window budget. Batch
// operations (sweep, archive-now, undo) pre-declare their exact allowance so
// legitimate bulk work passes while a runaway loop trips the breaker: all
// automation pauses and ONE notification reports it.

async function takeToken(ledgerKey, allowanceKey, windowMs, burst) {
  const data = await chrome.storage.session.get([ledgerKey, allowanceKey]);
  const ledger = (data[ledgerKey] || []).filter((ts) => now() - ts < windowMs);
  let allowance = data[allowanceKey] || 0;
  if (allowance > 0) {
    allowance--;
    await chrome.storage.session.set({ [ledgerKey]: ledger, [allowanceKey]: allowance });
    return true;
  }
  if (ledger.length >= burst) {
    await chrome.storage.session.set({ [ledgerKey]: ledger });
    return false;
  }
  ledger.push(now());
  await chrome.storage.session.set({ [ledgerKey]: ledger });
  return true;
}

async function withAllowance(allowanceKey, n, fn) {
  const data = await chrome.storage.session.get(allowanceKey);
  await chrome.storage.session.set({ [allowanceKey]: (data[allowanceKey] || 0) + n });
  try {
    return await fn();
  } finally {
    const after = await chrome.storage.session.get(allowanceKey);
    await chrome.storage.session.set({
      [allowanceKey]: Math.max(0, (after[allowanceKey] || 0) - n),
    });
  }
}

const withCloseAllowance = (n, fn) => withAllowance("closeAllowance", n, fn);
const withCreateAllowance = (n, fn) => withAllowance("createAllowance", n, fn);

async function isPaused() {
  const { pausedUntil = 0 } = await chrome.storage.session.get("pausedUntil");
  return now() < pausedUntil;
}

async function tripBreaker(reason) {
  await chrome.storage.session.set({ pausedUntil: now() + PAUSE_ON_TRIP_MS });
  traceDiag(`breaker tripped: ${reason}`);
  const { breakerNotifiedAt = 0 } = await chrome.storage.session.get("breakerNotifiedAt");
  if (now() - breakerNotifiedAt < BREAKER_RENOTIFY_MS) return;
  await chrome.storage.session.set({ breakerNotifiedAt: now() });
  await ensureI18n();
  chrome.notifications.create(
    "tt-breaker",
    {
      type: "basic",
      iconUrl: "icons/tt-128.png",
      title: ttI18n.t("notifBreakerTitle"),
      message: ttI18n.t("notifBreakerMsg"),
    },
    checked,
  );
}

// Every close this extension performs funnels through here.
async function closeTabsGuarded(tabIds, reason) {
  const granted = [];
  for (const id of tabIds) {
    if (await takeToken("closeLedger", "closeAllowance", CLOSE_WINDOW_MS, CLOSE_BURST)) {
      granted.push(id);
    } else {
      await tripBreaker(`close:${reason}`);
      break;
    }
  }
  if (!granted.length) return 0;
  await markSelfClosed(granted);
  for (const id of granted) await quiet(chrome.tabs.remove, id);
  let closed = 0;
  for (const id of granted) {
    let gone = !(await quiet(chrome.tabs.get, id));
    if (!gone) {
      await quiet(chrome.tabs.remove, id); // one retry
      gone = !(await quiet(chrome.tabs.get, id));
    }
    if (gone) closed++;
  }
  return closed;
}

async function guardedCreate(props, reason) {
  if (!(await takeToken("createLedger", "createAllowance", CREATE_WINDOW_MS, CREATE_BURST))) {
    await tripBreaker(`create:${reason}`);
    return null;
  }
  const tab = await quiet(chrome.tabs.create, props);
  // A tab WE created (undo, restore) commits like a user "link" navigation -
  // Chrome classifies API navigations that way. Mark it so dedup never eats
  // a tab the user just asked back.
  if (tab) await markSelfOp("created", tab.id);
  return tab;
}

// --- two-strikes anti-fight ledger -----------------------------------------------
// Classes: "dedup" (key), "group" (domain), "collapse" (domain or smart:title),
// "archive" (key). Two counteractions retire the class+key for the session.

async function strike(cls, key) {
  if (!key) return;
  const { strikes = {} } = await chrome.storage.session.get("strikes");
  const k = `${cls}:${key}`;
  const record = strikes[k] || { count: 0, lastAt: 0 };
  record.count++;
  record.lastAt = now();
  strikes[k] = record;
  await chrome.storage.session.set({ strikes });
  traceDiag(`strike ${k} = ${record.count}`);
}

async function isStruck(cls, key) {
  if (!key) return false;
  const { strikes = {} } = await chrome.storage.session.get("strikes");
  const record = strikes[`${cls}:${key}`];
  return !!record && record.count >= STRIKE_LIMIT;
}

// --- daily counters (storage.local) ------------------------------------------------

function localDateStr(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

async function getCounters() {
  const { counters } = await chrome.storage.local.get("counters");
  const today = localDateStr(now());
  if (!counters || counters.date !== today) {
    return { date: today, archivedToday: 0, dedupedToday: 0, sweptToday: 0 };
  }
  return counters;
}

async function bumpCounter(field, delta = 1) {
  const counters = await getCounters();
  counters[field] = Math.max(0, (counters[field] || 0) + delta);
  await chrome.storage.local.set({ counters });
}

// --- archive store -------------------------------------------------------------------
// One storage.local key, one writer (the queue), newest entries first.
// schemaVersion from day one: v1.1 may migrate to day buckets for omnibox.

async function getArchive() {
  const { archive } = await chrome.storage.local.get("archive");
  return archive && Array.isArray(archive.entries)
    ? archive
    : { schemaVersion: 1, entries: [], updatedAt: 0 };
}

async function archiveRMW(mutate) {
  const archive = await getArchive();
  const next = (await mutate(archive)) || archive;
  if (next.entries.length > ARCHIVE_CAP) next.entries.length = ARCHIVE_CAP;
  next.updatedAt = now();
  try {
    await chrome.storage.local.set({ archive: next });
  } catch (err) {
    // Quota: drop the oldest 500 and retry once. Newest-first order makes
    // "oldest" the tail.
    next.entries.length = Math.max(0, next.entries.length - 500);
    await chrome.storage.local.set({ archive: next });
    traceDiag(`archive quota fallback: ${err && err.message}`);
  }
  return next;
}

let batchSeq = 0;
const newBatchId = () => `${now().toString(36)}-${++batchSeq}`;

function makeEntry(tab, groupInfo, reason, batchId) {
  return {
    id: `${now().toString(36)}-${tab.id}-${Math.floor(Math.random() * 1e4)}`,
    url: tab.url,
    title: tab.title || tab.url,
    favUrl: tab.favIconUrl || null,
    domain: registrableDomain(tab.url),
    groupTitle: groupInfo ? groupInfo.title || null : null,
    groupColor: groupInfo ? groupInfo.color || null : null,
    winHint: tab.windowId,
    archivedAt: now(),
    batchId,
    reason, // "auto" | "manual" | "dupe-sweep"
  };
}

async function pruneArchiveTtl(force = false) {
  const settings = await getSettings();
  const ttl = archiveTtlMs(settings);
  if (!ttl) return;
  const { lastPruneAt = 0 } = await chrome.storage.session.get("lastPruneAt");
  if (!force && now() - lastPruneAt < 86400e3) return;
  await chrome.storage.session.set({ lastPruneAt: now() });
  await archiveRMW((archive) => {
    archive.entries = archive.entries.filter((e) => now() - e.archivedAt <= ttl);
    return archive;
  });
}

// --- dedup engine ----------------------------------------------------------------

// Classify a top-frame commit: only fresh, user-shaped navigations dedup.
// Redirect chains, form posts, reloads, history moves and extension-created
// tabs (auto_toplevel - TruePin's mirror copies and nav-forks commit as such)
// are never touched.
function classifyCommit(details) {
  if (details.frameId !== 0) return null;
  if (details.documentLifecycle && details.documentLifecycle !== "active") return null;
  const qualifiers = details.transitionQualifiers || [];
  if (qualifiers.includes("client_redirect") || qualifiers.includes("server_redirect")) return null;
  if (qualifiers.includes("forward_back")) return null;
  const type = details.transitionType;
  if (type === "reload") return null;
  if (type === "form_submit") return null;
  if (qualifiers.includes("from_address_bar") || ["typed", "generated", "keyword"].includes(type)) {
    return "address";
  }
  if (type === "auto_bookmark") return "bookmark";
  if (type === "link") return "link";
  return null;
}

function pickSurvivor(candidates, victimWindowId) {
  return candidates.sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Number(b.windowId === victimWindowId) - Number(a.windowId === victimWindowId) ||
      (b.lastAccessed || 0) - (a.lastAccessed || 0),
  )[0];
}

async function dedupOnCommit(tabId, url, kind, st) {
  const settings = await getSettings();
  if (!settings.dedupAuto || !(await isSettled()) || (await isPaused())) return;
  const key = dupeKey(url);
  if (!key) return;
  if (await isStruck("dedup", key)) return;
  if (await wasSelfOp("created", tabId)) return; // our own undo/restore tabs
  const tab = await quiet(chrome.tabs.get, tabId);
  if (!tab || tab.incognito || tab.pinned) return; // pinned is NEVER a victim
  const win = await quiet(chrome.windows.get, tab.windowId);
  if (!win || win.type !== "normal") return;
  // Only a tab's first real page is a victim: an existing tab that navigated
  // here carries a back-stack that a close would destroy. Arc dedups opens,
  // not in-place navigation.
  if (st.committedCount > FRESH_COMMIT_LIMIT) return;

  const all = await normalTabs(settings.dedupScope === "window" ? tab.windowId : null);
  const candidates = all.filter((t) => t.id !== tabId && dupeKey(t.url) === key);
  if (!candidates.length) return;

  let survivor = pickSurvivor(candidates, tab.windowId);
  survivor = await quiet(chrome.tabs.get, survivor.id);
  if (!survivor) return; // anchor vanished: the victim lives

  if (tab.active) {
    // The user is looking at the duplicate: switch the view first, then close.
    await quiet(chrome.tabs.update, survivor.id, { active: true });
    if (survivor.windowId !== tab.windowId) {
      await quiet(chrome.windows.update, survivor.windowId, { focused: true });
    }
  } // background duplicates close silently and steal no focus
  const closed = await closeTabsGuarded([tab.id], "dedup");
  if (!closed) return;
  const { dedupRecent = {} } = await chrome.storage.session.get("dedupRecent");
  dedupRecent[key] = { closedAt: now(), survivorId: survivor.id };
  await chrome.storage.session.set({ dedupRecent });
  await bumpCounter("dedupedToday");
  traceDiag(`dedup ${kind} ${key} -> kept ${survivor.id}`);
}

// Fast pre-empt: a FRESH tab heading to an already-open page is resolved at
// onBeforeNavigate - before network and paint - so the switch feels instant
// instead of "load, pause, merge". Classification is not available this
// early, but a fresh tab carries no history to lose; the one theoretical
// loss (a target=_blank form POST duplicating an open URL) keeps its origin
// page open, and the strike ledger covers any disagreement. Non-fresh tabs
// wait for the classified commit path.
async function dedupBeforeNavigate(details) {
  const st = await getTabState(details.tabId);
  if (st && st.committedCount > 0) return; // in-place navigation: commit path
  const key = dupeKey(details.url);
  if (!key) return;
  // Re-open detection normally lives on the commit; a pre-empted tab never
  // commits, so the strike check must happen here as well.
  const { dedupRecent = {} } = await chrome.storage.session.get("dedupRecent");
  const recent = dedupRecent[key];
  if (recent && now() - recent.closedAt < STRIKE_WINDOW_MS) {
    delete dedupRecent[key];
    await chrome.storage.session.set({ dedupRecent });
    await strike("dedup", key);
  }
  await dedupOnCommit(details.tabId, details.url, "pre-commit", st || newTabState(null));
}

// The user re-navigated an EXISTING tab (address bar, bookmark) to a page
// already open elsewhere. Attention wins: this tab is where the user is -
// the stale copy merges INTO it. Victims are archived first (one click away
// in the archive) and never pinned, audible, active, or inside a hand-made
// group. Returns the victim's OUR-group id for inheritance, if any.
async function mergeIntoNavigated(tabId, url, st) {
  const settings = await getSettings();
  if (!settings.dedupAuto || !(await isSettled()) || (await isPaused())) return null;
  const key = dupeKey(url);
  if (!key || (await isStruck("dedup", key))) return null;
  const tab = await quiet(chrome.tabs.get, tabId);
  if (!tab || tab.incognito || tab.pinned) return null;
  const win = await quiet(chrome.windows.get, tab.windowId);
  if (!win || win.type !== "normal") return null;
  const all = await normalTabs(settings.dedupScope === "window" ? tab.windowId : null);
  const ourGroups = await getOurGroups();
  const stale = all.filter(
    (t) =>
      t.id !== tabId &&
      dupeKey(t.url) === key &&
      !t.pinned &&
      !t.active &&
      !t.audible &&
      (t.groupId === -1 || t.groupId == null || ourGroups[t.groupId]),
  );
  if (!stale.length) return null;
  let inheritGid = null;
  const batchId = newBatchId();
  const cache = new Map();
  const entries = [];
  for (const t of stale) {
    entries.push(makeEntry(t, await groupInfoOf(t, cache), "merge", batchId));
    if (
      inheritGid == null &&
      t.groupId !== -1 &&
      t.groupId != null &&
      ourGroups[t.groupId] &&
      t.windowId === tab.windowId
    ) {
      inheritGid = t.groupId;
    }
  }
  await archiveRMW((archive) => {
    archive.entries = [...entries, ...archive.entries];
    return archive;
  });
  const closed = await closeTabsGuarded(stale.map((t) => t.id), "merge");
  if (closed) {
    const { dedupRecent = {} } = await chrome.storage.session.get("dedupRecent");
    dedupRecent[key] = { closedAt: now(), survivorId: tabId };
    await chrome.storage.session.set({ dedupRecent });
    await bumpCounter("dedupedToday", closed);
    traceDiag(`merge into navigated ${key}: closed ${closed}`);
  }
  return inheritGid;
}

// Count duplicates for the popup: tabs beyond the survivor in each bucket,
// plus surplus EMPTY new-tab pages (a pile of "New Tab" is duplicates too -
// they carry no content, so all but the active ones count).
function blankSurplus(tabs) {
  return tabs.filter((t) => isEphemeralUrl(t.url) && !t.pinned && !t.active).length;
}

function countDupes(tabs) {
  const buckets = new Map();
  for (const t of tabs) {
    const key = dupeKey(t.url);
    if (!key) continue;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  let extra = 0;
  for (const n of buckets.values()) extra += n - 1;
  return extra + blankSurplus(tabs);
}

// Manual sweep: an explicit command - ignores strikes and dedupAuto. Victims
// are archived (bulk closes deserve a free undo path); pinned and per-window
// active tabs always survive.
async function sweepDuplicates(scope, currentWindowId) {
  const tabs = await normalTabs(scope === "window" ? currentWindowId : null);
  const buckets = new Map();
  for (const t of tabs) {
    const key = dupeKey(t.url);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }
  const victims = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const survivor = bucket.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        Number(b.active) - Number(a.active) ||
        (b.lastAccessed || 0) - (a.lastAccessed || 0),
    )[0];
    for (const t of bucket) {
      if (t.id === survivor.id || t.pinned || t.active) continue;
      victims.push(t);
    }
  }
  // Surplus empty new-tab pages are duplicates of nothing: close them too
  // (not archived - there is no content to keep). Active/pinned blanks live.
  const blanks = tabs.filter((t) => isEphemeralUrl(t.url) && !t.pinned && !t.active);
  if (!victims.length && !blanks.length) return { closed: 0, batchId: null };
  const batchId = newBatchId();
  const groupInfoCache = new Map();
  const entries = [];
  for (const t of victims) {
    entries.push(makeEntry(t, await groupInfoOf(t, groupInfoCache), "dupe-sweep", batchId));
  }
  let closed = 0;
  await withCloseAllowance(victims.length + blanks.length, async () => {
    if (entries.length) {
      await archiveRMW((archive) => {
        archive.entries = [...entries, ...archive.entries];
        return archive;
      });
    }
    closed = await closeTabsGuarded(
      [...victims.map((t) => t.id), ...blanks.map((t) => t.id)],
      "sweep",
    );
  });
  await bumpCounter("sweptToday", closed);
  if (entries.length) {
    await chrome.storage.local.set({ lastBatch: { batchId, at: now(), count: entries.length } });
  }
  return { closed, batchId };
}

async function groupInfoOf(tab, cache) {
  if (tab.groupId === -1 || tab.groupId == null) return null;
  if (cache && cache.has(tab.groupId)) return cache.get(tab.groupId);
  const group = await quiet(chrome.tabGroups.get, tab.groupId);
  const info = group ? { title: group.title, color: group.color } : null;
  if (cache) cache.set(tab.groupId, info);
  return info;
}

// --- stale scan -> batch archive -> undo -------------------------------------------

function staleSince(tab, st) {
  if (tab.lastAccessed > 0) return tab.lastAccessed;
  return (st && st.firstSeenAt) || now();
}

function allowlistMatch(allowlist, url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (allowlist || []).some((raw) => {
    const d = String(raw || "").trim().toLowerCase();
    return d && (host === d || host.endsWith(`.${d}`));
  });
}

// The full exclusion fence. A tab is an archive candidate only if NOTHING
// here claims it. Pinned first: TruePin territory, war by construction.
async function archiveCandidates(settings, scopeWindowId = null) {
  const afterMs = archiveAfterMs(settings);
  if (!afterMs) return [];
  const { ourGroups = {} } = await chrome.storage.session.get("ourGroups");
  const tabs = await normalTabs(scopeWindowId);
  const out = [];
  for (const tab of tabs) {
    if (tab.pinned || tab.active || tab.audible) continue;
    if (!dupeKey(tab.url)) continue; // non-http(s), ephemeral: not restorable
    const st = await getTabState(tab.id);
    if (now() - staleSince(tab, st) < afterMs) continue;
    if (allowlistMatch(settings.archiveAllowlist, tab.url)) continue;
    if (tab.groupId !== -1 && tab.groupId != null) {
      const ours = ourGroups[tab.groupId];
      if (!ours && !settings.archiveForeignGroups) continue; // curated intent
      if (ours && now() - (ours.lastTouchedAt || 0) < afterMs) continue; // working set
    }
    if (await isStruck("archive", dupeKey(tab.url))) continue;
    out.push(tab);
  }
  return out;
}

async function archiveBatch(tabs, reason) {
  if (!tabs.length) return { archived: 0, batchId: null };
  const batchId = newBatchId();
  const cache = new Map();
  const entries = [];
  for (const tab of tabs) {
    entries.push(makeEntry(tab, await groupInfoOf(tab, cache), reason, batchId));
  }
  // Arm resurrection detection: a page that pops right back after our close
  // is being protected by something (TruePin's manual lock resurrects closed
  // tabs) - two rounds and the key is retired, no slow ping-pong loops.
  {
    const { archiveRecent = {} } = await chrome.storage.session.get("archiveRecent");
    for (const entry of entries) {
      const key = dupeKey(entry.url);
      if (key) archiveRecent[key] = now();
    }
    for (const [key, ts] of Object.entries(archiveRecent)) {
      if (now() - ts > STRIKE_WINDOW_MS) delete archiveRecent[key];
    }
    await chrome.storage.session.set({ archiveRecent });
  }
  // WRITE FIRST, close second: a service worker dying mid-batch leaves an
  // extra archive row, never a lost tab.
  await archiveRMW((archive) => {
    archive.entries = [...entries, ...archive.entries];
    return archive;
  });
  let closed = 0;
  await withCloseAllowance(tabs.length, async () => {
    closed = await closeTabsGuarded(tabs.map((t) => t.id), reason);
  });
  await bumpCounter("archivedToday", closed);
  await chrome.storage.local.set({ lastBatch: { batchId, at: now(), count: closed } });
  const settings = await getSettings();
  if (reason === "auto" && settings.archiveNotify && closed > 0) {
    await ensureI18n();
    chrome.notifications.create(
      `tt-batch-${batchId}`,
      {
        type: "basic",
        iconUrl: "icons/tt-128.png",
        title: ttI18n.t("notifBatchTitle"),
        message: ttI18n.t("notifBatchMsg", [closed]),
        buttons: [{ title: ttI18n.t("undoBtn") }],
      },
      checked,
    );
  }
  traceDiag(`archived ${closed} (${reason}) batch ${batchId}`);
  return { archived: closed, batchId };
}

async function undoBatch(batchId, { recordStrikes = true } = {}) {
  const archive = await getArchive();
  const entries = archive.entries.filter((e) => e.batchId === batchId);
  if (!entries.length) return { restored: 0 };
  let restored = 0;
  await withCreateAllowance(entries.length, async () => {
    for (const entry of entries.slice().reverse()) {
      const win = await quiet(chrome.windows.get, entry.winHint);
      const windowId = win && win.type === "normal" ? entry.winHint : undefined;
      const tab = await guardedCreate({ windowId, url: entry.url, active: false }, "undo");
      if (!tab) continue;
      restored++;
      const settings = await getSettings();
      if (entry.groupTitle && settings.autoGroup !== "off") {
        await regroupRestored(tab, entry);
      }
      if (recordStrikes) await strike("archive", dupeKey(entry.url));
    }
  });
  const ids = new Set(entries.map((e) => e.id));
  await archiveRMW((a) => {
    a.entries = a.entries.filter((e) => !ids.has(e.id));
    return a;
  });
  const { lastBatch } = await chrome.storage.local.get("lastBatch");
  if (lastBatch && lastBatch.batchId === batchId) {
    await chrome.storage.local.remove("lastBatch");
  }
  await bumpCounter("archivedToday", -restored);
  quiet(chrome.notifications.clear, `tt-batch-${batchId}`);
  traceDiag(`undo batch ${batchId}: ${restored} restored`);
  return { restored };
}

async function restoreEntries(ids) {
  const archive = await getArchive();
  const wanted = new Set(ids);
  const entries = archive.entries.filter((e) => wanted.has(e.id));
  if (!entries.length) return { restored: 0 };
  let restored = 0;
  await withCreateAllowance(entries.length, async () => {
    for (const entry of entries.slice().reverse()) {
      const win = await quiet(chrome.windows.get, entry.winHint);
      const windowId = win && win.type === "normal" ? entry.winHint : undefined;
      const tab = await guardedCreate({ windowId, url: entry.url, active: false }, "restore");
      if (!tab) continue;
      restored++;
      const settings = await getSettings();
      if (entry.groupTitle && settings.autoGroup !== "off") await regroupRestored(tab, entry);
    }
  });
  await archiveRMW((a) => {
    a.entries = a.entries.filter((e) => !wanted.has(e.id));
    return a;
  });
  return { restored };
}

// --- grouping engine ------------------------------------------------------------

async function getOurGroups() {
  const { ourGroups = {} } = await chrome.storage.session.get("ourGroups");
  return ourGroups;
}

async function putOurGroups(ourGroups) {
  await chrome.storage.session.set({ ourGroups });
}

function findOurGroup(ourGroups, windowId, domain) {
  for (const [gid, g] of Object.entries(ourGroups)) {
    if (g.windowId === windowId && g.domain === domain && !g.smart) return Number(gid);
  }
  return null;
}

async function upsertGroupSig(sig) {
  const { ourGroupSigs = [] } = await chrome.storage.local.get("ourGroupSigs");
  const next = ourGroupSigs.filter(
    (s) => !(s.title === sig.title && s.color === sig.color) && now() - s.lastSeenAt < SIG_TTL_MS,
  );
  next.push({ ...sig, lastSeenAt: now() });
  await chrome.storage.local.set({ ourGroupSigs: next });
}

async function removeGroupSig(title, color) {
  const { ourGroupSigs = [] } = await chrome.storage.local.get("ourGroupSigs");
  await chrome.storage.local.set({
    ourGroupSigs: ourGroupSigs.filter((s) => !(s.title === title && s.color === color)),
  });
}

// Restart recovery: group ids do not survive; re-adopt only on a 3-of-3
// signature (title + color + member-domain majority). Smart groups are NOT
// re-adopted (no domain to verify) - after a restart they are the user's.
async function readoptGroups() {
  const { ourGroupSigs = [] } = await chrome.storage.local.get("ourGroupSigs");
  if (!ourGroupSigs.length) return;
  const ourGroups = await getOurGroups();
  const known = new Set(Object.keys(ourGroups).map(Number));
  const groups = (await quiet(chrome.tabGroups.query, {})) || [];
  for (const group of groups) {
    if (known.has(group.id)) continue;
    const sig = ourGroupSigs.find(
      (s) => !s.smart && s.title === group.title && s.color === group.color,
    );
    if (!sig) continue;
    const members = await chrome.tabs.query({ groupId: group.id });
    if (!members.length) continue;
    const matching = members.filter((m) => registrableDomain(m.url) === sig.domain).length;
    if (matching < Math.ceil(members.length / 2)) continue;
    ourGroups[group.id] = {
      domain: sig.domain,
      title: group.title,
      color: group.color,
      windowId: group.windowId,
      createdAt: now(),
      lastTouchedAt: now(),
      collapsedByUs: !!group.collapsed,
      smart: false,
    };
    traceDiag(`re-adopted group ${group.id} (${sig.domain})`);
  }
  await putOurGroups(ourGroups);
}

async function createOurGroup(
  tabIds,
  windowId,
  { domain, title, color, smart = false, other = false, customId = null },
) {
  const gid = await quiet(chrome.tabs.group, {
    tabIds,
    createProperties: { windowId },
  });
  if (gid == null) return null;
  for (const id of tabIds) await markSelfOp("tabgroup", id);
  await quiet(chrome.tabGroups.update, gid, { title, color });
  const ourGroups = await getOurGroups();
  ourGroups[gid] = {
    domain: smart || customId ? null : domain,
    title,
    color,
    windowId,
    createdAt: now(),
    lastTouchedAt: now(),
    collapsedByUs: false,
    smart,
    other,
    customId,
  };
  await putOurGroups(ourGroups);
  if (!smart && !customId) await upsertGroupSig({ domain, title, color, smart: false });
  for (const id of tabIds) {
    const st = await getTabState(id);
    if (st) {
      st.groupedByUs = gid;
      await putTabState(id, st);
    }
  }
  const settings = await getSettings();
  if (other) {
    // "Other" is the catch-all: it always sinks to the very end of the window.
    await quiet(chrome.tabGroups.move, gid, { windowId, index: -1 });
  } else if (settings.groupsOnTop) {
    await moveGroupsToFront(windowId);
  }
  return gid;
}

async function addToOurGroup(tabId, gid) {
  await markSelfOp("tabgroup", tabId);
  const joined = await quiet(chrome.tabs.group, { tabIds: [tabId], groupId: gid });
  if (joined == null) return false;
  const ourGroups = await getOurGroups();
  if (ourGroups[gid]) {
    ourGroups[gid].lastTouchedAt = now();
    await putOurGroups(ourGroups);
  }
  const st = await getTabState(tabId);
  if (st) {
    st.groupedByUs = gid;
    await putTabState(tabId, st);
  }
  return true;
}

// Group title collision: two different domains would both label "Github"
// (github.com vs github.io) - the second falls back to the full domain.
function groupTitleFor(ourGroups, windowId, domain) {
  const label = cleanLabel(domain);
  for (const g of Object.values(ourGroups)) {
    if (g.windowId === windowId && g.title === label && g.domain !== domain) return domain;
  }
  return label;
}

// The user's rule group in a window: reuse the registered one, adopt an
// existing group with the exact rule name (post-restart continuity - the
// rule IS the user's intent for that name), or mint it around the tabs.
async function ensureCustomGroup(rule, windowId, tabIds) {
  const ourGroups = await getOurGroups();
  const registered = Object.entries(ourGroups).find(
    ([, g]) => g.customId === rule.id && g.windowId === windowId,
  );
  let gid = registered ? Number(registered[0]) : null;
  if (gid != null && !(await quiet(chrome.tabGroups.get, gid))) gid = null;
  if (gid == null) {
    const sameTitle = ((await quiet(chrome.tabGroups.query, { windowId })) || []).find(
      (g) => (g.title || "").toLowerCase() === rule.name.toLowerCase(),
    );
    if (sameTitle) {
      gid = sameTitle.id;
      ourGroups[gid] = {
        domain: null,
        title: sameTitle.title,
        color: sameTitle.color, // adopted: keep the user's paint
        windowId,
        createdAt: now(),
        lastTouchedAt: now(),
        collapsedByUs: false,
        smart: false,
        other: false,
        customId: rule.id,
      };
      await putOurGroups(ourGroups);
    }
  }
  if (gid != null) {
    for (const id of tabIds) await addToOurGroup(id, gid);
    return gid;
  }
  // Rule groups are explicit intent: min size 1, unlike auto site groups.
  return createOurGroup(tabIds, windowId, {
    title: rule.name,
    color: rule.color,
    customId: rule.id,
  });
}

// Deterministic rule routing for one freshly-committed tab. Returns true when
// the tab was taken. Runs before site/topic auto-grouping and regardless of
// the autoGroup mode - a rule is the user's standing order.
async function customAssign(tabId, st) {
  if (!(await isSettled()) || (await isPaused())) return false;
  const customs = await getCustomGroups();
  if (!customs.length) return false;
  const tab = await quiet(chrome.tabs.get, tabId);
  if (!tab || tab.pinned || tab.incognito) return false;
  if (tab.groupId !== -1 && tab.groupId != null) return false;
  if (st.ungroupedByUser) return false;
  const win = await quiet(chrome.windows.get, tab.windowId);
  if (!win || win.type !== "normal") return false;
  const rule = customRuleFor(customs, tab.url);
  if (!rule) return false;
  if (await isStruck("group", `custom:${rule.id}`)) return false;
  return (await ensureCustomGroup(rule, tab.windowId, [tab.id])) != null;
}

// After an address-bar/bookmark navigation the tab may sit in the wrong
// place: re-file it with the same standing orders that route new tabs.
// Priority: the user's rule, then the merged victim's group (the survivor
// literally takes its place), then an existing OUR group of the new domain;
// with no destination, a mismatched OUR site group releases the tab so the
// group's name stays honest. Hand-made groups are never touched - neither
// joined nor pulled from - and smart topic groups keep their members (a
// navigation does not necessarily leave the topic).
async function rehomeNavigated(tabId, st, inheritGid) {
  if (!(await isSettled()) || (await isPaused())) return;
  if (st.ungroupedByUser) return;
  const tab = await quiet(chrome.tabs.get, tabId);
  if (!tab || tab.pinned || tab.incognito) return;
  const win = await quiet(chrome.windows.get, tab.windowId);
  if (!win || win.type !== "normal") return;
  const ourGroups = await getOurGroups();
  const grouped = tab.groupId !== -1 && tab.groupId != null;
  const inOur = grouped ? ourGroups[tab.groupId] : null;
  if (grouped && !inOur) return; // a hand-made group is not ours to rearrange
  const domain = st.domain;

  const customs = await getCustomGroups();
  const rule = customRuleFor(customs, tab.url);
  if (rule && !(await isStruck("group", `custom:${rule.id}`))) {
    if (inOur && inOur.customId === rule.id) return; // already home
    await ensureCustomGroup(rule, tab.windowId, [tab.id]);
    return;
  }
  if (
    inheritGid != null &&
    inheritGid !== tab.groupId &&
    (await quiet(chrome.tabGroups.get, inheritGid))
  ) {
    if (await addToOurGroup(tab.id, inheritGid)) return;
  }
  if (domain && !(await isStruck("group", domain))) {
    const existing = findOurGroup(ourGroups, tab.windowId, domain);
    if (existing === tab.groupId) return; // already right
    if (existing != null && (await addToOurGroup(tab.id, existing))) return;
  }
  if (inOur && !inOur.smart && !inOur.customId && inOur.domain && inOur.domain !== domain) {
    await markSelfOp("tabgroup", tab.id);
    await quiet(chrome.tabs.ungroup, [tab.id]);
  }
}

// Rule pre-pass over a pool of tabs (Organize / Smart Organize): domain-rule
// matches leave the pool and land in their rule groups first.
async function routeCustoms(pool, windowId, createdGids) {
  const customs = await getCustomGroups();
  const rest = [];
  const byRule = new Map();
  let grouped = 0;
  for (const t of pool) {
    const rule = customs.length ? customRuleFor(customs, t.url) : null;
    if (rule && !(await isStruck("group", `custom:${rule.id}`))) {
      if (!byRule.has(rule.id)) byRule.set(rule.id, { rule, ids: [] });
      byRule.get(rule.id).ids.push(t.id);
    } else {
      rest.push(t);
    }
  }
  for (const { rule, ids } of byRule.values()) {
    const before = new Set(Object.keys(await getOurGroups()));
    const gid = await ensureCustomGroup(rule, windowId, ids);
    if (gid != null) {
      grouped += ids.length;
      if (!before.has(String(gid))) createdGids.push(gid);
    }
  }
  return { rest, grouped };
}

// Continuous mode: gentle - only a tab's FIRST commit, never a re-shuffle.
// The autoGroup gate lives in the caller (handleCommit routes off/site/topic).
async function groupOnCommit(tabId, st) {
  if (!(await isSettled()) || (await isPaused())) return;
  const tab = await quiet(chrome.tabs.get, tabId);
  if (!tab || tab.pinned || tab.incognito) return;
  const win = await quiet(chrome.windows.get, tab.windowId);
  if (!win || win.type !== "normal") return;
  if (tab.groupId !== -1 && tab.groupId != null) return; // never move out of ANY group
  if (st.committedCount > 1) return;
  if (st.ungroupedByUser) return; // pulled out once: hands off for the session
  const domain = st.domain;
  if (!domain || !st.key) return;
  if (await isStruck("group", domain)) return;

  const ourGroups = await getOurGroups();
  const existing = findOurGroup(ourGroups, tab.windowId, domain);
  if (existing != null) {
    if (await addToOurGroup(tab.id, existing)) return;
  }
  // Min size 2: a one-tab group is strip churn with zero organizational
  // value. The group is born the moment a second same-domain tab exists.
  const peers = (await chrome.tabs.query({ windowId: tab.windowId, pinned: false })).filter(
    (t) =>
      t.id !== tab.id &&
      (t.groupId === -1 || t.groupId == null) &&
      registrableDomain(t.url) === domain &&
      !isEphemeralUrl(t.url),
  );
  const eligible = [];
  for (const peer of peers) {
    const peerSt = await getTabState(peer.id);
    if (!peerSt || !peerSt.ungroupedByUser) eligible.push(peer);
  }
  if (!eligible.length) return;
  await createOurGroup([tab.id, ...eligible.map((t) => t.id)], tab.windowId, {
    domain,
    title: groupTitleFor(ourGroups, tab.windowId, domain),
    color: colorFor(domain),
  });
}

// Explicit command: the user just asked - ungroupedByUser tabs ARE included;
// members of foreign groups are not loose, pinned never participate.
async function organizeNow(scope, currentWindowId) {
  const windows = await normalWindows();
  const targets = scope === "window" ? windows.filter((w) => w.id === currentWindowId) : windows;
  let grouped = 0;
  let groupsCreated = 0;
  const createdGids = [];
  for (const win of targets) {
    const loose = (await chrome.tabs.query({ windowId: win.id, pinned: false })).filter(
      (t) => (t.groupId === -1 || t.groupId == null) && !isEphemeralUrl(t.url),
    );
    // The user's rule groups outrank site grouping: route matches first.
    const beforeCustom = createdGids.length;
    const routed = await routeCustoms(loose, win.id, createdGids);
    grouped += routed.grouped;
    groupsCreated += createdGids.length - beforeCustom;
    const byDomain = new Map();
    for (const t of routed.rest) {
      const domain = registrableDomain(t.url);
      if (!domain || !dupeKey(t.url)) continue;
      if (!byDomain.has(domain)) byDomain.set(domain, []);
      byDomain.get(domain).push(t);
    }
    for (const [domain, list] of byDomain) {
      const ourGroups = await getOurGroups();
      const existing = findOurGroup(ourGroups, win.id, domain);
      if (existing != null) {
        for (const t of list) {
          if (await addToOurGroup(t.id, existing)) grouped++;
        }
      } else if (list.length >= 2) {
        const gid = await createOurGroup(
          list.map((t) => t.id),
          win.id,
          { domain, title: groupTitleFor(ourGroups, win.id, domain), color: colorFor(domain) },
        );
        if (gid != null) {
          grouped += list.length;
          groupsCreated++;
          createdGids.push(gid);
        }
      }
    }
    await applySort(win.id);
    const settings = await getSettings();
    if (settings.groupsOnTop) await moveGroupsToFront(win.id);
  }
  await rememberOrganize(createdGids);
  return { grouped, groupsCreated };
}

// One-click undo for an Organize: dissolve only the groups THAT RUN created
// (joins into pre-existing groups are left alone - conservative).
async function rememberOrganize(gids) {
  if (!gids.length) return;
  await chrome.storage.session.set({ lastOrganize: { gids, at: now() } });
}

async function undoOrganize() {
  const { lastOrganize } = await chrome.storage.session.get("lastOrganize");
  if (!lastOrganize || !lastOrganize.gids.length) return { ungrouped: 0 };
  let ungrouped = 0;
  const ourGroups = await getOurGroups();
  for (const gid of lastOrganize.gids) {
    const members = await chrome.tabs.query({ groupId: gid });
    if (!members.length) continue;
    for (const m of members) await markSelfOp("tabgroup", m.id); // not a user pull-out
    await quiet(chrome.tabs.ungroup, members.map((m) => m.id));
    ungrouped += members.length;
    if (ourGroups[gid] && !ourGroups[gid].smart) {
      await removeGroupSig(ourGroups[gid].title, ourGroups[gid].color);
    }
    delete ourGroups[gid];
  }
  await putOurGroups(ourGroups);
  await chrome.storage.session.remove("lastOrganize");
  return { ungrouped };
}

// Optional deterministic order, applied only on explicit Organize. Two axes:
// sortGroups orders OUR groups among themselves (in place - foreign groups and
// the block's position stay), sortTabs orders tabs inside each of our groups
// and the loose tabs. Modes: title (A-Z), recent (last used first), opened
// (oldest first); "live" is the continuous surface-on-use behavior and reads
// as "recent" here.
async function applySort(windowId) {
  const settings = await getSettings();
  const groupMode = settings.sortGroups === "live" ? "recent" : settings.sortGroups;
  const tabMode = settings.sortTabs === "live" ? "recent" : settings.sortTabs;
  if (groupMode === "off" && tabMode === "off") return;
  const ourGroups = await getOurGroups();
  const tabs = await chrome.tabs.query({ windowId });
  const st = new Map();
  for (const t of tabs) st.set(t.id, await getTabState(t.id));
  const metricBy = (mode) => (t) => {
    if (mode === "title") return (t.title || t.url || "").toLowerCase();
    if (mode === "opened") return (st.get(t.id) && st.get(t.id).firstSeenAt) || 0;
    return -(t.lastAccessed || 0); // recent: most recently used first
  };
  const cmpBy = (mode) => {
    const metric = metricBy(mode);
    return (a, b) => (metric(a) < metric(b) ? -1 : metric(a) > metric(b) ? 1 : 0);
  };
  const groupIds = [...new Set(tabs.filter((t) => t.groupId !== -1).map((t) => t.groupId))];
  const ourGids = groupIds.filter((gid) => ourGroups[gid]);

  // Tabs inside each of OUR groups: moves stay within the group's span, so
  // membership is never disturbed.
  if (tabMode !== "off") {
    const cmp = cmpBy(tabMode);
    for (const gid of ourGids) {
      const members = tabs.filter((t) => t.groupId === gid);
      if (members.length < 2) continue;
      const first = Math.min(...members.map((t) => t.index));
      const sorted = [...members].sort(cmp);
      for (let i = 0; i < sorted.length; i++) {
        await quiet(chrome.tabs.move, sorted[i].id, { index: first + i });
      }
    }
  }

  // OUR groups (never the catch-all, never foreign ones) ranked by their best
  // member and re-laid sequentially from the block's current start.
  if (groupMode !== "off") {
    const cmp = cmpBy(groupMode);
    const groupBest = new Map();
    for (const gid of ourGids) {
      if (ourGroups[gid].other) continue;
      const members = tabs.filter((t) => t.groupId === gid).sort(cmp);
      if (members.length) groupBest.set(gid, members[0]);
    }
    const orderedGids = [...groupBest.keys()].sort((a, b) =>
      cmp(groupBest.get(a), groupBest.get(b)),
    );
    if (orderedGids.length > 1) {
      const sizeOf = (gid) => tabs.filter((t) => t.groupId === gid).length;
      let cursor = Math.min(
        ...orderedGids.map((gid) => Math.min(...tabs.filter((t) => t.groupId === gid).map((t) => t.index))),
      );
      for (const gid of orderedGids) {
        await quiet(chrome.tabGroups.move, gid, { windowId, index: cursor });
        cursor += sizeOf(gid);
      }
    }
  }

  // Loose tabs go after the groups, in order.
  if (tabMode !== "off") {
    const loose = tabs
      .filter((t) => !t.pinned && (t.groupId === -1 || t.groupId == null))
      .sort(cmpBy(tabMode));
    for (const t of loose) {
      await quiet(chrome.tabs.move, t.id, { windowId, index: -1 });
    }
  }

  // The catch-all keeps its contract: the very end of the window.
  const otherGid = ourGids.find((gid) => ourGroups[gid].other);
  if (otherGid != null) {
    await quiet(chrome.tabGroups.move, Number(otherGid), { windowId, index: -1 });
  }
}

// --- live sort (MRU): the tab you use surfaces ---------------------------------
// sortTabs="live": after a short dwell on a tab it moves to the front of its
// container (its group, or the loose block). sortGroups="live": its group
// rises to the front of the strip. The dwell keeps Ctrl+Tab cycling and quick
// glances from churning the strip; only one pending surface at a time.
let mruTimer = null;

function scheduleMruSurface(tabId) {
  clearTimeout(mruTimer);
  const dwell = globalThis.__ttMruDwellMs ?? 3000;
  mruTimer = setTimeout(() => {
    enqueue(() => mruSurface(tabId), "mru");
  }, dwell);
}

async function mruSurface(tabId) {
  const settings = await getSettings();
  const liveTabs = settings.sortTabs === "live";
  const liveGroups = settings.sortGroups === "live";
  if (!liveTabs && !liveGroups) return;
  if (!(await isSettled()) || (await isPaused())) return;
  const tab = await quiet(chrome.tabs.get, tabId);
  if (!tab || !tab.active || tab.pinned) return;
  const win = await quiet(chrome.windows.get, tab.windowId);
  if (!win || win.type !== "normal" || win.incognito) return;
  const inGroup = tab.groupId !== -1 && tab.groupId != null;
  const ourGroups = await getOurGroups();

  if (liveTabs) {
    if (inGroup) {
      const members = await chrome.tabs.query({ groupId: tab.groupId });
      const first = Math.min(...members.map((m) => m.index));
      if (tab.index !== first) await quiet(chrome.tabs.move, tab.id, { index: first });
    } else {
      // Front of the LOOSE block, wherever it starts: groups are not shoved.
      const all = await chrome.tabs.query({ windowId: tab.windowId });
      const loose = all.filter((t) => !t.pinned && (t.groupId === -1 || t.groupId == null));
      const first = Math.min(...loose.map((t) => t.index));
      if (tab.index !== first) await quiet(chrome.tabs.move, tab.id, { index: first });
    }
  }

  if (liveGroups && inGroup) {
    const ours = ourGroups[tab.groupId];
    // Only OUR groups surface (foreign layout is not ours to touch), and the
    // catch-all never leaves the back of the strip.
    if (ours && !ours.other) {
      const all = await chrome.tabs.query({ windowId: tab.windowId });
      const pinnedCount = all.filter((t) => t.pinned).length;
      const members = all.filter((t) => t.groupId === tab.groupId);
      const first = Math.min(...members.map((m) => m.index));
      if (first !== pinnedCount) {
        await quiet(chrome.tabGroups.move, tab.groupId, {
          windowId: tab.windowId,
          index: pinnedCount,
        });
      }
      ours.lastTouchedAt = now();
      await putOurGroups(ourGroups);
    }
  }
}

async function collapseScan() {
  const settings = await getSettings();
  const afterMs = collapseAfterMs(settings);
  if (!afterMs) return;
  const ourGroups = await getOurGroups();
  let dirty = false;
  for (const [gidStr, g] of Object.entries(ourGroups)) {
    const gid = Number(gidStr);
    if (now() - (g.lastTouchedAt || 0) < afterMs) continue;
    const strikeKey = g.smart ? `smart:${g.title}` : g.domain;
    if (await isStruck("collapse", strikeKey)) continue;
    const group = await quiet(chrome.tabGroups.get, gid);
    if (!group) {
      delete ourGroups[gidStr];
      dirty = true;
      continue;
    }
    if (group.collapsed) continue;
    const members = await chrome.tabs.query({ groupId: gid });
    if (members.some((m) => m.active || m.audible)) continue; // never under the user's feet
    await quiet(chrome.tabGroups.update, gid, { collapsed: true });
    g.collapsedByUs = true;
    dirty = true;
  }
  if (dirty) await putOurGroups(ourGroups);
}

// Ungroup one group / all groups: explicit user commands from the popup.
// Members get self-op markers so the dissolve never reads as user pull-outs.
async function ungroupOne(gid, ourGroups) {
  const members = await chrome.tabs.query({ groupId: gid });
  if (members.length) {
    for (const m of members) await markSelfOp("tabgroup", m.id);
    await quiet(chrome.tabs.ungroup, members.map((m) => m.id));
  }
  if (ourGroups[gid]) {
    if (!ourGroups[gid].smart) await removeGroupSig(ourGroups[gid].title, ourGroups[gid].color);
    delete ourGroups[gid];
  }
  return members.length;
}

async function ungroupAll() {
  const ourGroups = await getOurGroups();
  let ungrouped = 0;
  let groupsGone = 0;
  for (const group of (await quiet(chrome.tabGroups.query, {})) || []) {
    const win = await quiet(chrome.windows.get, group.windowId);
    if (!win || win.type !== "normal" || win.incognito) continue;
    ungrouped += await ungroupOne(group.id, ourGroups);
    groupsGone++;
  }
  await putOurGroups(ourGroups);
  return { ungrouped, groupsGone };
}

// Keep groups at the front of the strip (after pins), preserving their
// relative order; an "Other" smart group always sinks to the back of the
// group block. Applied on Organize and when a new group is minted.
async function moveGroupsToFront(windowId) {
  const ourGroups = await getOurGroups();
  const tabs = await chrome.tabs.query({ windowId });
  const pinnedCount = tabs.filter((t) => t.pinned).length;
  const groups = ((await quiet(chrome.tabGroups.query, { windowId })) || [])
    .map((g) => {
      const members = tabs.filter((t) => t.groupId === g.id);
      return {
        id: g.id,
        size: members.length,
        first: members.length ? Math.min(...members.map((t) => t.index)) : Infinity,
        other: !!(ourGroups[g.id] && ourGroups[g.id].other),
      };
    })
    .filter((g) => g.size > 0)
    .sort((a, b) => Number(a.other) - Number(b.other) || a.first - b.first);
  let cursor = pinnedCount;
  for (const g of groups) {
    await quiet(chrome.tabGroups.move, g.id, { windowId, index: cursor });
    cursor += g.size;
  }
}

// Restore an archived tab into its group context: join or recreate OUR group
// for its domain in that window.
async function regroupRestored(tab, entry) {
  const domain = entry.domain || registrableDomain(entry.url);
  if (!domain) return;
  const ourGroups = await getOurGroups();
  const existing = findOurGroup(ourGroups, tab.windowId, domain);
  if (existing != null) {
    await addToOurGroup(tab.id, existing);
    return;
  }
  await createOurGroup([tab.id], tab.windowId, {
    domain,
    title: entry.groupTitle || groupTitleFor(ourGroups, tab.windowId, domain),
    color: entry.groupColor || colorFor(domain),
  });
}

// --- merge windows ------------------------------------------------------------------
// Loose tabs and whole groups (title/color/collapsed preserved) move into the
// target window. Pinned tabs are NEVER moved: Chrome unpins on cross-window
// move and TruePin would re-mirror - moving them starts a war. A window left
// holding only pinned tabs stays open; an emptied window closes itself.

async function mergeWindows(targetWindowId) {
  const target = await quiet(chrome.windows.get, targetWindowId);
  if (!target || target.type !== "normal" || target.incognito) {
    return { moved: 0, groupsMoved: 0, windowsEmptied: 0, pinnedLeft: 0 };
  }
  let moved = 0;
  let groupsMoved = 0;
  let windowsEmptied = 0;
  let pinnedLeft = 0;
  const ourGroups = await getOurGroups();
  for (const win of await normalWindows()) {
    if (win.id === targetWindowId) continue;
    const groups = (await quiet(chrome.tabGroups.query, { windowId: win.id })) || [];
    for (const group of groups) {
      const members = await chrome.tabs.query({ groupId: group.id });
      for (const m of members) await markSelfOp("tabgroup", m.id);
      const movedGroup = await quiet(chrome.tabGroups.move, group.id, {
        windowId: targetWindowId,
        index: -1,
      });
      if (movedGroup) {
        groupsMoved++;
        moved += members.length;
        if (ourGroups[group.id]) ourGroups[group.id].windowId = targetWindowId;
      }
    }
    const loose = (await chrome.tabs.query({ windowId: win.id, pinned: false })).filter(
      (t) => t.groupId === -1 || t.groupId == null,
    );
    if (loose.length) {
      for (const t of loose) await markSelfOp("tabgroup", t.id);
      await quiet(chrome.tabs.move, loose.map((t) => t.id), {
        windowId: targetWindowId,
        index: -1,
      });
      moved += loose.length;
    }
    const left = await chrome.tabs.query({ windowId: win.id });
    if (!left.length) windowsEmptied++;
    else pinnedLeft += left.filter((t) => t.pinned).length;
  }
  await putOurGroups(ourGroups);
  await quiet(chrome.windows.update, targetWindowId, { focused: true });
  return { moved, groupsMoved, windowsEmptied, pinnedLeft };
}

// --- smart (AI) grouping engine ---------------------------------------------------
// Three tiers behind one interface: on-device Gemini Nano (Prompt API),
// the user's own key (OpenAI / Gemini / Grok / custom OpenAI-compatible),
// or off. One prompt shape, one JSON contract, one validator; any failure
// falls back silently to domain grouping. The BYOK key lives ONLY in
// storage.local and is masked in diagnostics.

const BYOK_PRESETS = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  grok: { baseUrl: "https://api.x.ai/v1", model: "grok-3-mini" },
  gemini: { model: "gemini-2.0-flash" },
};

async function getByokKey() {
  const { byokKey = "" } = await chrome.storage.local.get("byokKey");
  return byokKey;
}

async function smartAvailability() {
  if (globalThis.__ttMockAi) return globalThis.__ttMockAi.availability || "available";
  if (typeof LanguageModel === "undefined") return "unavailable";
  try {
    return await LanguageModel.availability();
  } catch {
    return "unavailable";
  }
}

function smartPrompt(items, existingTopics = []) {
  const list = items.map((it, i) => `${i}. [${it.domain}] ${it.title}`).join("\n");
  const topics = existingTopics.length
    ? `Existing group names - REUSE these names when tabs fit them:\n${existingTopics
        .map((t) => `- ${t}`)
        .join("\n")}\n\n`
    : "";
  return (
    "You organize browser tabs into topic groups.\n" +
    "Cluster the numbered tabs below into 3-10 groups.\n" +
    "Rules:\n" +
    "- EVERY tab must be assigned to exactly one group. Do not leave tabs " +
    "out unless a tab is truly unrelated to everything else.\n" +
    "- Tabs from one site usually belong together: a group per dominant " +
    'site is good (e.g. all YouTube tabs -> "YouTube").\n' +
    "- Prefer broad, useful groups over many tiny ones.\n" +
    "- Group names: 1-3 words, at most 25 characters, in the dominant " +
    "language of the titles.\n" +
    'Answer with ONLY JSON: {"groups":[{"name":"...","tabIndices":[0,2]}]}\n\n' +
    topics +
    `Tabs:\n${list}`
  );
}

const SMART_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          tabIndices: { type: "array", items: { type: "integer" } },
        },
        required: ["name", "tabIndices"],
      },
    },
  },
  required: ["groups"],
};

async function smartCallBuiltin(promptText, onChunk) {
  if (globalThis.__ttMockAi) {
    const mock = globalThis.__ttMockAi;
    if (onChunk && mock.respondStream) return mock.respondStream(promptText, onChunk);
    return mock.respond(promptText);
  }
  const session = await LanguageModel.create({ temperature: 0, topK: 1 });
  try {
    // Streaming when the caller wants progress: the answer is watched as it
    // is generated, so a slow on-device model still shows per-tab movement.
    if (onChunk && session.promptStreaming) {
      try {
        let text = "";
        const stream = session.promptStreaming(promptText, {
          responseConstraint: SMART_SCHEMA,
        });
        for await (const chunk of stream) {
          // Older Chrome builds stream the full text so far, newer ones deltas.
          text =
            chunk.length >= text.length && chunk.startsWith(text.slice(0, 40))
              ? chunk
              : text + chunk;
          onChunk(text);
        }
        return text;
      } catch {
        // fall through to the plain path
      }
    }
    try {
      return await session.prompt(promptText, { responseConstraint: SMART_SCHEMA });
    } catch {
      return await session.prompt(promptText);
    }
  } finally {
    if (session.destroy) session.destroy();
  }
}

async function smartCallByok(promptText, settings) {
  if (globalThis.__ttMockAi) return globalThis.__ttMockAi.respond(promptText);
  const key = await getByokKey();
  if (!key) throw new Error("no API key");
  const provider = settings.byokProvider;
  const preset = BYOK_PRESETS[provider] || {};
  const model = settings.byokModel || preset.model || "";
  if (provider === "gemini") {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    });
    if (!res.ok) throw new Error(`gemini http ${res.status}`);
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("gemini empty response");
    return text;
  }
  const baseUrl = (provider === "custom" ? settings.byokBaseUrl : preset.baseUrl || "").replace(
    /\/$/,
    "",
  );
  if (!baseUrl) throw new Error("no endpoint");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: promptText }],
    }),
  });
  if (!res.ok) throw new Error(`byok http ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("byok empty response");
  return text;
}

async function smartCall(promptText, onChunk) {
  const settings = await getSettings();
  if (settings.smartEngine === "builtin") return smartCallBuiltin(promptText, onChunk);
  if (settings.smartEngine === "byok") {
    try {
      return await smartCallByok(promptText, settings);
    } catch (err) {
      // One retry with backoff on rate limits, then give up (fallback upstream).
      if (/429/.test(String(err && err.message))) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return smartCallByok(promptText, settings);
      }
      throw err;
    }
  }
  throw new Error("smart engine off");
}

// Strict validation: garbage in, domain grouping out - never garbage groups.
function parseSmartResponse(text, itemCount) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.groups)) return null;
  const seen = new Set();
  const groups = [];
  for (const g of data.groups) {
    if (!g || typeof g.name !== "string" || !Array.isArray(g.tabIndices)) continue;
    const name = g.name.trim().slice(0, 30);
    if (!name) continue;
    const indices = [];
    for (const idx of g.tabIndices) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= itemCount || seen.has(idx)) continue;
      seen.add(idx);
      indices.push(idx);
    }
    if (indices.length >= 2) groups.push({ name, tabIndices: indices });
  }
  return groups.length ? groups : null;
}

// Smart Organize v3. The run itself stays OFF the mutation queue (a slow model
// must never freeze the engine or the popup); every mutation goes through the
// queue as its own small job. Per window:
//   1) rule pre-pass - the user's domain rules route deterministically;
//   2) AI batches with per-tab progress (streamed token counting on the
//      built-in tier), each parsed batch APPLIED IMMEDIATELY - groups appear
//      while the model keeps thinking, one undo record covers the whole run;
//      themes merge by name across batches and later batches see the names
//      already minted (the user's rule names are reserved topics);
//   3) a refinement call gives the leftovers a second chance to form NEW
//      specific topics before any of them is written off;
//   4) the tail: if the model dumped over half the pool, it is grouped BY
//      SITE; only true singletons land in the localized "Other" (always last).

async function setSmartProgress(done, total) {
  if (total > 0) await chrome.storage.session.set({ smartProgress: { done, total } });
  else await chrome.storage.session.remove("smartProgress");
}

function refinePrompt(items, existingTopics) {
  const list = items.map((it, i) => `${i}. [${it.domain}] ${it.title}`).join("\n");
  const topics = existingTopics.length
    ? `Existing group names - REUSE these when a tab fits:\n${existingTopics
        .map((t) => `- ${t}`)
        .join("\n")}\n\n`
    : "";
  return (
    "You organize browser tabs into topic groups.\n" +
    "These tabs did not fit the big groups. Find SPECIFIC new topics that " +
    "connect 2-4 of them, or match an existing name below.\n" +
    "Rules:\n" +
    "- Only group tabs that genuinely share a topic; a tab with no clear " +
    "partner must be LEFT OUT.\n" +
    "- Group names: 1-3 words, at most 25 characters, in the dominant " +
    "language of the titles.\n" +
    'Answer with ONLY JSON: {"groups":[{"name":"...","tabIndices":[0,2]}]}\n\n' +
    topics +
    `Tabs:\n${list}`
  );
}

// The topic list a batch sees: names already live in this run + the user's
// rule groups (with their hints, so the model knows what belongs there).
function smartTopicLines(themes, customs) {
  const lines = new Map();
  for (const t of themes.values()) lines.set(t.name.toLowerCase(), t.name);
  for (const c of customs) {
    if (c.on) lines.set(c.name.toLowerCase(), c.hint ? `${c.name} (${c.hint})` : c.name);
  }
  return [...lines.values()];
}

// Apply one parsed batch as a queued job: extend live themes, honor the
// user's rule names, mint new groups. Returns the claimed indices and the
// ids the model claimed but the world no longer allows (bounced).
async function applySmartBatch(windowId, parsed, batch, themes, customs, settings, run) {
  return enqueue(async () => {
    const assigned = new Set();
    const bounced = [];
    const customByLower = new Map(
      customs.filter((c) => c.on).map((c) => [c.name.toLowerCase(), c]),
    );
    for (const g of parsed) {
      const key = g.name.toLowerCase();
      const ourGroupsNow = await getOurGroups();
      const live = [];
      for (const i of g.tabIndices) {
        assigned.add(i);
        const t = await quiet(chrome.tabs.get, batch[i].id);
        if (!t || t.pinned || t.windowId !== windowId) continue;
        const inGroup = t.groupId !== -1 && t.groupId != null;
        if (inGroup) {
          const owner = ourGroupsNow[t.groupId];
          const known = themes.get(key);
          if (known && known.gid === t.groupId) continue; // already where it belongs
          if (!owner || owner.customId || !settings.smartRegroupOurs) continue; // not ours to move
        }
        live.push(t.id);
      }
      if (!live.length) continue;
      const known = themes.get(key);
      if (known && known.gid != null && (await quiet(chrome.tabGroups.get, known.gid))) {
        for (const id of live) {
          if (await addToOurGroup(id, known.gid)) run.grouped++;
        }
        continue;
      }
      const custom = customByLower.get(key);
      if (custom) {
        const before = new Set(Object.keys(await getOurGroups()));
        const gid = await ensureCustomGroup(custom, windowId, live);
        if (gid != null) {
          run.grouped += live.length;
          if (!before.has(String(gid))) {
            run.groupsCreated++;
            run.createdGids.push(gid);
          }
          themes.set(key, { name: custom.name, gid });
        } else {
          bounced.push(...live);
        }
        continue;
      }
      if (live.length < 2) {
        bounced.push(...live);
        continue;
      }
      const gid = await createOurGroup(live, windowId, {
        title: g.name,
        color: colorFor(g.name),
        smart: true,
      });
      if (gid != null) {
        run.grouped += live.length;
        run.groupsCreated++;
        run.createdGids.push(gid);
        themes.set(key, { name: g.name, gid });
      } else {
        bounced.push(...live);
      }
    }
    return { assigned, bounced };
  }, "apply-smart");
}

async function smartRunWindow(windowId, pool, totalPool, done, run, settings) {
  // 1) The user's rules route first - deterministic, no model involved.
  const routed = await enqueue(() => routeCustoms(pool, windowId, run.createdGids), "smart-rules");
  run.grouped += routed.grouped;
  done += pool.length - routed.rest.length;
  await setSmartProgress(done, totalPool);
  const rest = routed.rest;

  const customs = await getCustomGroups();
  const themes = new Map(); // lower(name) -> { name, gid }
  for (const [gid, g] of Object.entries(await getOurGroups())) {
    if (g.smart && !g.other && g.windowId === windowId) {
      themes.set(g.title.toLowerCase(), { name: g.title, gid: Number(gid) });
    }
  }

  // 2) AI batches, applied as they land.
  const unassigned = [];
  let aiFailures = 0;
  for (let offset = 0; offset < rest.length; offset += SMART_BATCH) {
    const batch = rest.slice(offset, offset + SMART_BATCH);
    const items = batch.map((t) => ({
      domain: registrableDomain(t.url),
      title: (t.title || t.url).slice(0, 120),
    }));
    let lastWrite = 0;
    const doneSoFar = done;
    const onChunk = (text) => {
      // Cosmetic per-tab progress inside a batch: distinct indices already
      // visible in the streamed JSON, throttled to ~6 writes a second.
      const at = Date.now();
      if (at - lastWrite < 150) return;
      lastWrite = at;
      const seen = new Set(
        (text.match(/\d+/g) || []).map(Number).filter((n) => n >= 0 && n < batch.length),
      );
      setSmartProgress(doneSoFar + Math.min(seen.size, batch.length - 1), totalPool);
    };
    let parsed = null;
    try {
      parsed = parseSmartResponse(
        await smartCall(smartPrompt(items, smartTopicLines(themes, customs)), onChunk),
        items.length,
      );
    } catch (err) {
      traceDiag(`smart call failed: ${err && err.message}`);
    }
    if (!parsed) {
      aiFailures++;
      unassigned.push(...batch.map((t) => t.id));
    } else {
      const { assigned, bounced } = await applySmartBatch(
        windowId,
        parsed,
        batch,
        themes,
        customs,
        settings,
        run,
      );
      unassigned.push(...bounced);
      batch.forEach((t, i) => {
        if (!assigned.has(i)) unassigned.push(t.id);
      });
    }
    done += batch.length;
    await setSmartProgress(done, totalPool);
  }

  // 3) Refinement: leftovers get one focused second chance before the tail.
  let leftovers = [];
  for (const id of unassigned) {
    const t = await quiet(chrome.tabs.get, id);
    if (t && !t.pinned && (t.groupId === -1 || t.groupId == null)) leftovers.push(t);
  }
  if (!aiFailures && leftovers.length >= 6) {
    const items = leftovers.map((t) => ({
      domain: registrableDomain(t.url),
      title: (t.title || t.url).slice(0, 120),
    }));
    try {
      const parsed = parseSmartResponse(
        await smartCall(refinePrompt(items, smartTopicLines(themes, customs))),
        items.length,
      );
      if (parsed) {
        const { assigned, bounced } = await applySmartBatch(
          windowId,
          parsed,
          leftovers,
          themes,
          customs,
          settings,
          run,
        );
        const bouncedSet = new Set(bounced);
        leftovers = leftovers.filter((t, i) => !assigned.has(i) || bouncedSet.has(t.id));
      }
    } catch (err) {
      traceDiag(`smart refine failed: ${err && err.message}`);
    }
  }

  // 4) The tail, one queued job: site fallback, then the catch-all.
  await enqueue(async () => {
    let loose = [];
    for (const t of leftovers) {
      const live = await quiet(chrome.tabs.get, t.id);
      if (live && !live.pinned && (live.groupId === -1 || live.groupId == null)) loose.push(live);
    }
    if (aiFailures > 0 || loose.length > rest.length / 2) {
      run.fellBack = true;
      const byDomain = new Map();
      for (const t of loose) {
        const domain = registrableDomain(t.url);
        if (!byDomain.has(domain)) byDomain.set(domain, []);
        byDomain.get(domain).push(t);
      }
      loose = [];
      for (const [domain, list] of byDomain) {
        if (list.length >= 2) {
          const ourGroups = await getOurGroups();
          const gid = await createOurGroup(
            list.map((t) => t.id),
            windowId,
            {
              domain,
              title: groupTitleFor(ourGroups, windowId, domain),
              color: colorFor(domain),
            },
          );
          if (gid != null) {
            run.grouped += list.length;
            run.groupsCreated++;
            run.createdGids.push(gid);
          }
        } else {
          loose.push(...list);
        }
      }
    }
    if (settings.smartOther && loose.length >= 2) {
      await ensureI18n();
      const existingOther = Object.entries(await getOurGroups()).find(
        ([, g]) => g.other && g.windowId === windowId,
      );
      if (existingOther) {
        for (const t of loose) {
          if (await addToOurGroup(t.id, Number(existingOther[0]))) run.grouped++;
        }
        await quiet(chrome.tabGroups.move, Number(existingOther[0]), { windowId, index: -1 });
      } else {
        const gid = await createOurGroup(
          loose.map((t) => t.id),
          windowId,
          { title: ttI18n.t("smartOtherName"), color: "grey", smart: true, other: true },
        );
        if (gid != null) {
          run.grouped += loose.length;
          run.groupsCreated++;
          run.createdGids.push(gid);
        }
      }
    }
    await applySort(windowId);
    if (settings.groupsOnTop) await moveGroupsToFront(windowId);
  }, "smart-tail");
  return done;
}

async function smartOrganize(scope, currentWindowId) {
  const settings = await getSettings();
  if (settings.smartEngine === "off") return { grouped: 0, groupsCreated: 0, fellBack: false };
  const { smartRunning } = await chrome.storage.session.get("smartRunning");
  if (smartRunning && now() - smartRunning < 10 * 60e3) return { busy: true };
  await chrome.storage.session.set({ smartRunning: now() });
  try {
    const windows = await normalWindows();
    const targets = scope === "window" ? windows.filter((w) => w.id === currentWindowId) : windows;
    const ourGroups = await getOurGroups();
    const pools = [];
    let totalPool = 0;
    for (const win of targets) {
      const all = await chrome.tabs.query({ windowId: win.id, pinned: false });
      // Loose tabs + members of OUR auto groups when the user allows rebuilds;
      // hand-made and rule groups are never re-pooled. Sorted by site so
      // batches keep natural clusters together.
      const pool = all
        .filter((t) => {
          if (!dupeKey(t.url)) return false;
          if (t.groupId === -1 || t.groupId == null) return true;
          const owner = ourGroups[t.groupId];
          return !!owner && !owner.customId && settings.smartRegroupOurs;
        })
        .sort((a, b) => registrableDomain(a.url).localeCompare(registrableDomain(b.url)));
      if (pool.length >= 2) {
        pools.push({ windowId: win.id, pool });
        totalPool += pool.length;
      }
    }
    if (!totalPool) return { grouped: 0, groupsCreated: 0, fellBack: false };
    const run = { grouped: 0, groupsCreated: 0, fellBack: false, createdGids: [] };
    let done = 0;
    try {
      for (const { windowId, pool } of pools) {
        done = await smartRunWindow(windowId, pool, totalPool, done, run, settings);
      }
    } finally {
      await setSmartProgress(0, 0);
    }
    await rememberOrganize(run.createdGids);
    return { grouped: run.grouped, groupsCreated: run.groupsCreated, fellBack: run.fellBack };
  } finally {
    await chrome.storage.session.remove("smartRunning");
  }
}

// Lazy classification of one new tab (autoGroup = "topic"): existing smart
// groups plus the user's rule groups with hints are the candidates. Returns
// "fallback" when the tier is structurally unavailable (no model, no key) -
// the caller then groups by site, so topic mode never silently does nothing.
async function smartAssign(tabId, st) {
  const settings = await getSettings();
  if (settings.smartEngine === "off") return "fallback";
  if (settings.smartEngine === "builtin" && (await smartAvailability()) !== "available") {
    return "fallback";
  }
  if (settings.smartEngine === "byok" && !(await getByokKey()) && !globalThis.__ttMockAi) {
    return "fallback";
  }
  if (!(await isSettled()) || (await isPaused())) return false;
  const tab = await quiet(chrome.tabs.get, tabId);
  if (!tab || tab.pinned || (tab.groupId !== -1 && tab.groupId != null)) return false;
  if (st.ungroupedByUser) return false;
  const ourGroups = await getOurGroups();
  const candidates = [];
  for (const [gid, g] of Object.entries(ourGroups)) {
    if (g.smart && !g.other && g.windowId === tab.windowId) {
      candidates.push({ label: g.title, gid: Number(gid) });
    }
  }
  for (const c of await getCustomGroups()) {
    if (!c.on || !c.hint) continue;
    if (candidates.some((x) => x.label.toLowerCase() === c.name.toLowerCase())) continue;
    if (await isStruck("group", `custom:${c.id}`)) continue;
    candidates.push({ label: `${c.name} - ${c.hint}`, custom: c });
  }
  if (!candidates.length) return false;
  const promptText =
    "Pick the best topic group for this browser tab, or none.\n" +
    `Tab: [${st.domain}] ${(tab.title || tab.url).slice(0, 120)}\n` +
    `Groups: ${candidates.map((c, i) => `${i}. ${c.label}`).join(", ")}\n` +
    'Answer with ONLY JSON: {"group": <index or null>}';
  let idx = null;
  try {
    const data = JSON.parse(
      String(await smartCall(promptText)).replace(/^```(?:json)?\s*|\s*```$/g, ""),
    );
    if (Number.isInteger(data.group) && data.group >= 0 && data.group < candidates.length) {
      idx = data.group;
    }
  } catch {
    return false; // silent: assignment is best-effort sugar
  }
  if (idx == null) return false;
  const pick = candidates[idx];
  if (pick.custom) return (await ensureCustomGroup(pick.custom, tab.windowId, [tab.id])) != null;
  return addToOurGroup(tab.id, pick.gid);
}

// --- alarm tick -----------------------------------------------------------------------

async function tick() {
  await pruneArchiveTtl();
  if (!(await isSettled()) || (await isPaused())) return;
  const settings = await getSettings();
  const afterMs = archiveAfterMs(settings);
  if (afterMs) {
    // Optional intermediate tier: discard (memory freed, tab stays visible)
    // at half-threshold. Never both discard and archive in one tick.
    const candidates = await archiveCandidates(settings);
    if (settings.discardStale) {
      const candidateIds = new Set(candidates.map((t) => t.id));
      for (const tab of await normalTabs()) {
        if (tab.pinned || tab.active || tab.audible || tab.discarded) continue;
        if (candidateIds.has(tab.id)) continue;
        if (!dupeKey(tab.url)) continue;
        if (allowlistMatch(settings.archiveAllowlist, tab.url)) continue;
        const st = await getTabState(tab.id);
        if (now() - staleSince(tab, st) >= afterMs / 2) {
          await quiet(chrome.tabs.discard, tab.id);
        }
      }
    }
    if (candidates.length) {
      await archiveBatch(candidates.slice(0, ARCHIVE_BATCH_MAX), "auto");
    }
  }
  await collapseScan();
}

function ensureAlarm() {
  // get-then-create: an SW wake must not reset the alarm's phase.
  chrome.alarms.get(TICK_ALARM, (alarm) => {
    checked();
    if (!alarm) chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  });
}

// --- ui:* backend -----------------------------------------------------------------------

async function uiGetState(request) {
  const settings = await getSettings();
  const tabs = await normalTabs();
  const windows = await normalWindows();
  const staleNow = (await archiveCandidates(settings)).length;
  const counters = await getCounters();
  const archive = await getArchive();
  const { lastBatch = null } = await chrome.storage.local.get("lastBatch");
  const { settled = false, lastOrganize = null } = await chrome.storage.session.get([
    "settled",
    "lastOrganize",
  ]);
  // Live group list for the popup: every group in normal windows, ours
  // flagged (the popup lets the user jump/collapse/reorder any of them -
  // explicit user acts, not automation).
  const ourGroups = await getOurGroups();
  const groups = [];
  for (const group of (await quiet(chrome.tabGroups.query, {})) || []) {
    if (!windows.some((w) => w.id === group.windowId)) continue;
    const members = tabs.filter((t) => t.groupId === group.id);
    groups.push({
      id: group.id,
      title: group.title || "",
      color: group.color,
      collapsed: !!group.collapsed,
      windowId: group.windowId,
      tabCount: members.length,
      firstTabIndex: members.length ? Math.min(...members.map((t) => t.index)) : -1,
      ours: !!ourGroups[group.id],
    });
  }
  groups.sort((a, b) => a.windowId - b.windowId || a.firstTabIndex - b.firstTabIndex);
  return {
    counts: {
      tabs: tabs.length,
      windows: windows.length,
      dupes: countDupes(tabs),
      staleNow,
      archivedToday: counters.archivedToday,
      dedupedToday: counters.dedupedToday,
      archiveTotal: archive.entries.length,
    },
    settings,
    customGroups: await getCustomGroups(),
    groups,
    lastBatch,
    lastOrganize,
    paused: await isPaused(),
    settled,
    smartAvailability: await smartAvailability(),
    smartProgress: (await chrome.storage.session.get("smartProgress")).smartProgress || null,
    byokKeySet: !!(await getByokKey()),
  };
}

async function handleUi(request) {
  if (globalThis.__ttFailUi) throw new Error("simulated engine failure"); // test hook
  switch (request.type) {
    case "ui:getState":
      return uiGetState(request);
    case "ui:setSetting": {
      if (!(request.key in DEFAULTS)) return { ok: false };
      const { settings = {} } = await chrome.storage.sync.get("settings");
      settings[request.key] = request.value;
      // Persist the normalized shape: a bad value degrades to the default
      // instead of poisoning storage for every later read.
      await chrome.storage.sync.set({ settings: normalizeSettings(settings) });
      i18nReady = null; // language may have changed
      if (request.key === "iconStyle") applyActionIcon(request.value);
      return { ok: true };
    }
    case "ui:customGroups:set": {
      const list = normalizeCustomGroups(request.list);
      // Sync gives one item ~8KB: rules must never be what breaks saving.
      if (JSON.stringify(list).length > 7000) return { ok: false, error: "tooBig" };
      await chrome.storage.sync.set({ customGroups: list });
      return { ok: true, customGroups: list };
    }
    case "ui:organizeNow":
      return organizeNow(request.scope || "window", request.windowId);
    case "ui:smartOrganize":
      return smartOrganize(request.scope || "window", request.windowId);
    case "ui:undoOrganize":
      return undoOrganize();
    case "ui:groupCollapse": {
      // Explicit user act from the popup. Expanding OUR collapsed group by
      // hand must not read as an automation strike - mark it.
      const ourGroups = await getOurGroups();
      if (request.collapsed === false && ourGroups[request.gid]) {
        await markSelfOp("groupexpand", request.gid);
      }
      await quiet(chrome.tabGroups.update, request.gid, { collapsed: !!request.collapsed });
      if (ourGroups[request.gid]) {
        ourGroups[request.gid].collapsedByUs = !!request.collapsed;
        ourGroups[request.gid].lastTouchedAt = now();
        await putOurGroups(ourGroups);
      }
      return { ok: true };
    }
    case "ui:groupsCollapseAll": {
      const ourGroups = await getOurGroups();
      let changed = 0;
      for (const group of (await quiet(chrome.tabGroups.query, {})) || []) {
        const win = await quiet(chrome.windows.get, group.windowId);
        if (!win || win.type !== "normal" || win.incognito) continue;
        if (group.collapsed === !!request.collapsed) continue;
        if (request.collapsed) {
          const members = await chrome.tabs.query({ groupId: group.id });
          if (members.some((m) => m.active)) continue; // Chrome forbids collapsing the active group
        } else if (ourGroups[group.id]) {
          await markSelfOp("groupexpand", group.id);
        }
        await quiet(chrome.tabGroups.update, group.id, { collapsed: !!request.collapsed });
        if (ourGroups[group.id]) {
          ourGroups[group.id].collapsedByUs = !!request.collapsed;
          ourGroups[group.id].lastTouchedAt = now();
        }
        changed++;
      }
      await putOurGroups(ourGroups);
      return { changed };
    }
    case "ui:groupFocus": {
      const members = await chrome.tabs.query({ groupId: request.gid });
      if (!members.length) return { ok: false };
      if ((await quiet(chrome.tabGroups.get, request.gid))?.collapsed) {
        const ourGroups = await getOurGroups();
        if (ourGroups[request.gid]) await markSelfOp("groupexpand", request.gid);
        await quiet(chrome.tabGroups.update, request.gid, { collapsed: false });
      }
      const target = members.find((m) => m.active) || members[0];
      await quiet(chrome.tabs.update, target.id, { active: true });
      await quiet(chrome.windows.update, target.windowId, { focused: true });
      return { ok: true };
    }
    case "ui:groupUngroup": {
      const ourGroups = await getOurGroups();
      const ungrouped = await ungroupOne(request.gid, ourGroups);
      await putOurGroups(ourGroups);
      return { ungrouped };
    }
    case "ui:groupsUngroupAll":
      return ungroupAll();
    case "ui:groupReorder": {
      // Popup drag-reorder: the popup sends the FINAL order of a window's
      // groups; they are laid out sequentially from the block's current
      // start. A user command, not automation. Boundary-safe by walking:
      // each placement lands on the edge left by the previous one.
      const tabs = await chrome.tabs.query({ windowId: request.windowId });
      const sizes = new Map();
      for (const t of tabs) {
        if (t.groupId === -1 || t.groupId == null) continue;
        sizes.set(t.groupId, (sizes.get(t.groupId) || 0) + 1);
      }
      const wanted = (request.gids || []).filter((gid) => sizes.get(gid) > 0);
      if (wanted.length < 2) return { ok: false };
      let cursor = Math.min(
        ...tabs.filter((t) => wanted.includes(t.groupId)).map((t) => t.index),
      );
      for (const gid of wanted) {
        await quiet(chrome.tabGroups.move, gid, { windowId: request.windowId, index: cursor });
        cursor += sizes.get(gid);
      }
      return { ok: true };
    }
    case "ui:sweepDupes":
      return sweepDuplicates(request.scope || "window", request.windowId);
    case "ui:archiveStaleNow": {
      const settings = await getSettings();
      const withThreshold =
        settings.archiveAfter === "off" ? { ...settings, archiveAfter: "24h" } : settings;
      const candidates = await archiveCandidates(withThreshold, request.windowId ?? null);
      return archiveBatch(candidates, "manual");
    }
    case "ui:mergeWindows":
      return mergeWindows(request.targetWindowId);
    case "ui:undoLastBatch": {
      let batchId = request.batchId;
      if (!batchId) {
        const { lastBatch } = await chrome.storage.local.get("lastBatch");
        batchId = lastBatch && lastBatch.batchId;
      }
      if (!batchId) return { restored: 0 };
      return undoBatch(batchId);
    }
    case "ui:archive:list": {
      await pruneArchiveTtl(true);
      const archive = await getArchive();
      return { entries: archive.entries, total: archive.entries.length };
    }
    case "ui:archive:restore":
      return restoreEntries(request.ids || []);
    case "ui:archive:delete": {
      const wanted = new Set(request.ids || []);
      let deleted = 0;
      await archiveRMW((a) => {
        const before = a.entries.length;
        a.entries = a.entries.filter((e) => !wanted.has(e.id));
        deleted = before - a.entries.length;
        return a;
      });
      return { deleted };
    }
    case "ui:archive:clear": {
      let deleted = 0;
      await archiveRMW((a) => {
        if (request.scope === "day" && request.day) {
          const before = a.entries.length;
          a.entries = a.entries.filter((e) => localDateStr(e.archivedAt) !== request.day);
          deleted = before - a.entries.length;
        } else {
          deleted = a.entries.length;
          a.entries = [];
        }
        return a;
      });
      return { deleted };
    }
    case "ui:byokSetKey": {
      await chrome.storage.local.set({ byokKey: String(request.key || "") });
      return { ok: true };
    }
    case "ui:byokTest": {
      try {
        const text = await smartCallByok(
          'Reply with ONLY JSON: {"ok":true}',
          await getSettings(),
        );
        const data = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, ""));
        return { ok: data && data.ok === true };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }
    case "ui:smartStatus":
      return {
        availability: await smartAvailability(),
        engine: (await getSettings()).smartEngine,
        byokKeySet: !!(await getByokKey()),
      };
    case "ui:smartEnable": {
      // Explicit user click: create() may trigger the one-time model download.
      if (globalThis.__ttMockAi) return { status: "available" };
      if (typeof LanguageModel === "undefined") return { status: "unavailable" };
      try {
        const session = await LanguageModel.create({
          monitor(m) {
            m.addEventListener("downloadprogress", (e) => {
              chrome.storage.session.set({
                smartDownload: { loaded: e.loaded, total: e.total || 1 },
              });
            });
          },
        });
        if (session.destroy) session.destroy();
        await chrome.storage.session.remove("smartDownload");
        return { status: "available" };
      } catch (err) {
        return { status: "unavailable", error: String((err && err.message) || err) };
      }
    }
    case "ui:diagnostics": {
      const settings = await getSettings();
      const session = await chrome.storage.session.get([
        "settled",
        "pausedUntil",
        "strikes",
        "ourGroups",
        "closeLedger",
        "createLedger",
      ]);
      const counters = await getCounters();
      const archive = await getArchive();
      const { ourGroupSigs = [] } = await chrome.storage.local.get("ourGroupSigs");
      const windows = [];
      for (const win of await chrome.windows.getAll({ populate: true })) {
        windows.push({
          id: win.id,
          type: win.type,
          incognito: win.incognito,
          tabCount: (win.tabs || []).length,
          urls: (win.tabs || []).map((t) => t.url), // urls only - titles can leak content
        });
      }
      return {
        version: chrome.runtime.getManifest().version,
        settings: { ...settings },
        byokKey: (await getByokKey()) ? "set" : "absent",
        settled: !!session.settled,
        pausedUntil: session.pausedUntil || 0,
        counters,
        strikes: session.strikes || {},
        ourGroups: session.ourGroups || {},
        sigs: ourGroupSigs,
        ledgers: {
          close: (session.closeLedger || []).length,
          create: (session.createLedger || []).length,
        },
        archive: {
          total: archive.entries.length,
          oldestAt: archive.entries.length
            ? archive.entries[archive.entries.length - 1].archivedAt
            : null,
        },
        windows,
        trace: globalThis.__ttDiag.trace.slice(),
        at: new Date().toISOString(),
      };
    }
    default:
      return { error: `unknown message: ${request.type}` };
  }
}

// --- event listeners (top-level, synchronous registration) ------------------------------

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  ensureSettleBootstrap();
  // Settle stored state into the current shape once per install/update.
  // Reads are normalized anyway; this write-back prunes retired keys.
  enqueue(async () => {
    const { settings } = await chrome.storage.sync.get("settings");
    if (settings) await chrome.storage.sync.set({ settings: normalizeSettings(settings) });
  }, "migrate-settings");
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  ensureSettleBootstrap();
});

async function handleCommit(details) {
  if (details.frameId !== 0) return;
  const st = (await getTabState(details.tabId)) || newTabState(null);
  if (!st.firstSeenAt) st.firstSeenAt = now();
  st.url = details.url;
  st.key = dupeKey(details.url);
  st.domain = registrableDomain(details.url);
  // Only real pages count: a new tab's about:blank/newtab commit does not
  // spend its "fresh" status - the first CONTENT page is the first commit.
  if (st.key) st.committedCount++;
  await putTabState(details.tabId, st);

  // Strike detection: the user re-opened a key we recently dedup-closed.
  if (st.key) {
    const { dedupRecent = {} } = await chrome.storage.session.get("dedupRecent");
    const recent = dedupRecent[st.key];
    if (recent && now() - recent.closedAt < STRIKE_WINDOW_MS) {
      delete dedupRecent[st.key];
      await chrome.storage.session.set({ dedupRecent });
      await strike("dedup", st.key);
    }
    // Resurrection detection: a page we just archived came straight back -
    // another extension (TruePin lock) is protecting it. Strike the archive
    // class for this key; two rounds retire it for the session.
    const { archiveRecent = {} } = await chrome.storage.session.get("archiveRecent");
    if (archiveRecent[st.key] && now() - archiveRecent[st.key] < STRIKE_WINDOW_MS) {
      delete archiveRecent[st.key];
      await chrome.storage.session.set({ archiveRecent });
      await strike("archive", st.key);
    }
  }

  const kind = classifyCommit(details);
  if (kind) await dedupOnCommit(details.tabId, details.url, kind, st);

  // In-place re-navigation via the address bar or a bookmark: attention wins.
  // The stale copy elsewhere merges INTO this tab, and the tab is re-filed
  // by the same standing orders that route new tabs. Link browsing inside a
  // group is a reading flow and never reshuffles anything.
  if ((kind === "address" || kind === "bookmark") && st.committedCount > FRESH_COMMIT_LIMIT) {
    const stNow = await getTabState(details.tabId);
    if (stNow) {
      const inheritGid = await mergeIntoNavigated(details.tabId, details.url, stNow);
      await rehomeNavigated(details.tabId, stNow, inheritGid);
    }
  }

  // The tab may be gone (dedup closed it); grouping re-checks liveness.
  // Routing order: the user's rules first (a standing order, active in every
  // mode), then the autoGroup mode - by site, or by topic with a site
  // fallback while the AI tier is structurally unavailable.
  const after = await getTabState(details.tabId);
  if (after) {
    const settings = await getSettings();
    const taken = await customAssign(details.tabId, after);
    if (!taken) {
      const post = await getTabState(details.tabId);
      if (post && !post.groupedByUs) {
        if (settings.autoGroup === "site") {
          await groupOnCommit(details.tabId, post);
        } else if (settings.autoGroup === "topic") {
          const assigned = await smartAssign(details.tabId, post);
          if (assigned === "fallback") await groupOnCommit(details.tabId, post);
        }
      }
    }
  }
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  // Prerender/speculative navigations are not user acts - never dedup them.
  if (details.documentLifecycle && details.documentLifecycle !== "active") return;
  enqueue(() => dedupBeforeNavigate(details), "before-nav");
});

chrome.webNavigation.onCommitted.addListener((details) => {
  enqueue(() => handleCommit(details), "commit");
});

chrome.tabs.onCreated.addListener((tab) => {
  enqueue(async () => {
    if (!(await getTabState(tab.id))) await putTabState(tab.id, newTabState(tab));
  }, "created");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.groupId === undefined && changeInfo.url === undefined) return;
  enqueue(async () => {
    const st = await getTabState(tabId);
    if (!st) return;
    if (changeInfo.url !== undefined) {
      st.url = changeInfo.url;
      st.key = dupeKey(changeInfo.url);
      st.domain = registrableDomain(changeInfo.url);
      await putTabState(tabId, st);
    }
    if (changeInfo.groupId !== undefined) {
      const wasOurs = st.groupedByUs;
      if (changeInfo.groupId === -1 && wasOurs != null) {
        st.groupedByUs = null;
        if (!(await consumeSelfOp("tabgroup", tabId))) {
          // CLOSING a grouped tab also fires groupId=-1 before the removal.
          // By the time this queued job runs the removal has landed - a tab
          // that is gone was closed, not pulled out: never a strike.
          const live = await quiet(chrome.tabs.get, tabId);
          if (live) {
            // The user pulled this tab out of our group: hands off, and two
            // pulled-out tabs of one domain (or one rule group) retire that
            // auto-grouping key for the session.
            st.ungroupedByUser = true;
            const owner = (await getOurGroups())[wasOurs];
            await strike(
              "group",
              owner && owner.customId ? `custom:${owner.customId}` : st.domain,
            );
          }
        }
        await putTabState(tabId, st);
      } else if (changeInfo.groupId !== -1) {
        const ourGroups = await getOurGroups();
        st.groupedByUs = ourGroups[changeInfo.groupId] ? changeInfo.groupId : null;
        await putTabState(tabId, st);
      }
    }
  }, "updated");
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  scheduleMruSurface(tabId); // live sort: acts only after the dwell, if enabled
  enqueue(async () => {
    const tab = await quiet(chrome.tabs.get, tabId);
    if (!tab || tab.groupId === -1 || tab.groupId == null) return;
    const ourGroups = await getOurGroups();
    if (ourGroups[tab.groupId]) {
      ourGroups[tab.groupId].lastTouchedAt = now();
      await putOurGroups(ourGroups);
    }
  }, "activated");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(async () => {
    await dropTabState(tabId);
  }, "removed");
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  enqueue(async () => {
    const st = await getTabState(removedTabId);
    if (st) {
      await putTabState(addedTabId, st);
      await dropTabState(removedTabId);
    }
  }, "replaced");
});

chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => {
  enqueue(async () => {
    const st = await getTabState(tabId);
    if (st && st.groupedByUs != null) {
      // Cross-window drag ungroups implicitly; onUpdated(groupId) handles the
      // registry side. Nothing to do beyond keeping state fresh.
      st.groupedByUs = null;
      await putTabState(tabId, st);
    }
  }, "attached");
});

chrome.tabGroups.onUpdated.addListener((group) => {
  enqueue(async () => {
    const ourGroups = await getOurGroups();
    const ours = ourGroups[group.id];
    if (!ours) return;
    // Our own ops echo the registry values (same title/color; collapsed only
    // ever set to TRUE by us), so a difference below is the user's act - with
    // one exception: creating a group fires an onUpdated echo with an EMPTY
    // title before our own title/color update lands. Groups we manage are
    // always named, so an empty-title event is that echo, never a rename.
    if (!group.title && ours.title) {
      ours.windowId = group.windowId;
      await putOurGroups(ourGroups);
      return;
    }
    if (group.title !== ours.title || group.color !== ours.color) {
      // The user claimed it: disowned forever - never renamed, filled or
      // collapsed by us again.
      if (!ours.smart) await removeGroupSig(ours.title, ours.color);
      delete ourGroups[group.id];
      await putOurGroups(ourGroups);
      traceDiag(`group ${group.id} disowned`);
      return;
    }
    if (group.collapsed === false && ours.collapsedByUs) {
      ours.collapsedByUs = false;
      ours.lastTouchedAt = now();
      // Expanding via OUR popup buttons is the user commanding us, not the
      // user fighting our automation - no strike then.
      if (!(await consumeSelfOp("groupexpand", group.id))) {
        await strike("collapse", ours.smart ? `smart:${ours.title}` : ours.domain);
      }
    }
    ours.windowId = group.windowId;
    await putOurGroups(ourGroups);
  }, "group-updated");
});

chrome.tabGroups.onRemoved.addListener((group) => {
  enqueue(async () => {
    const ourGroups = await getOurGroups();
    if (ourGroups[group.id]) {
      delete ourGroups[group.id];
      await putOurGroups(ourGroups);
    }
  }, "group-removed");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TICK_ALARM) return;
  enqueue(tick, "tick");
});

chrome.notifications.onButtonClicked.addListener((notificationId) => {
  if (!notificationId.startsWith("tt-batch-")) return;
  const batchId = notificationId.slice("tt-batch-".length);
  enqueue(() => undoBatch(batchId), "undo-notif");
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith("tt-batch-")) return;
  chrome.tabs.create({ url: chrome.runtime.getURL("archive.html") }, checked);
});

// Long-running calls that do NOT mutate our state (model download, provider
// test) bypass the FIFO queue - otherwise every settings write would hang
// behind a multi-minute download and the options page would look dead.
const OFF_QUEUE_UI = new Set(["ui:smartEnable", "ui:byokTest", "ui:smartOrganize"]);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || typeof request.type !== "string" || !request.type.startsWith("ui:")) {
    return false;
  }
  // Both branches answer with {error} on failure: a page must always get a
  // response it can judge, never a hung port or an unhandled rejection.
  if (OFF_QUEUE_UI.has(request.type)) {
    handleUi(request).then(sendResponse, (err) =>
      sendResponse({ error: String((err && err.message) || err) }),
    );
  } else {
    enqueue(() => handleUi(request), `ui ${request.type}`).then(sendResponse, (err) =>
      sendResponse({ error: String((err && err.message) || err) }),
    );
  }
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings) i18nReady = null;
});

// --- action icon (color | mono, TruePin parity) ---------------------------------------------

function applyActionIcon(style) {
  const prefix = style === "mono" ? "tt-mono" : "tt";
  chrome.action.setIcon(
    {
      path: {
        16: `icons/${prefix}-16.png`,
        32: `icons/${prefix}-32.png`,
        48: `icons/${prefix}-48.png`,
        128: `icons/${prefix}-128.png`,
      },
    },
    checked,
  );
}

// --- bootstrap + test hooks ---------------------------------------------------------------

ensureAlarm();
ensureSettleBootstrap();
getSettings().then((settings) => applyActionIcon(settings.iconStyle));

// Mirror onMessage exactly: off-queue types call handleUi directly - routing
// them through the queue would deadlock smartOrganize, whose APPLY phase
// enqueues its own job (a job cannot await the queue it is running on).
globalThis.__ttUiCall = (request) =>
  OFF_QUEUE_UI.has(request.type)
    ? handleUi(request)
    : enqueue(() => handleUi(request), `test ${request.type}`);
globalThis.__ttTick = ({ now: overrideNow } = {}) =>
  // The clock override must live INSIDE the queued job: setting it before
  // enqueue would leak future time into whatever events sit in the queue
  // ahead of the tick (e.g. an onActivated touch).
  enqueue(async () => {
    clockOverride = overrideNow ?? null;
    try {
      await tick();
    } finally {
      clockOverride = null;
    }
  }, "test tick");
globalThis.__ttSimulateCommit = (details) =>
  enqueue(() => handleCommit({ frameId: 0, transitionQualifiers: [], ...details }), "test commit");
globalThis.__ttClassifyCommit = classifyCommit;
globalThis.__ttNormalizeUrl = normalizeUrl;
globalThis.__ttSetClock = (value) => {
  clockOverride = value ?? null;
};
globalThis.__ttForceSettle = async () => {
  await chrome.storage.session.set({
    settled: true,
    sessionStartedAt: Date.now() - SETTLE_MIN_MS - 1000,
  });
};
globalThis.__ttWipeState = async () => {
  await chrome.storage.session.clear();
  await chrome.storage.local.clear();
  await chrome.storage.sync.clear();
  i18nReady = null;
};
globalThis.__ttSimulateReload = async () => {
  await chrome.storage.session.clear();
  ensureSettleBootstrap();
};
globalThis.__ttSeedArchive = (entries) =>
  enqueue(
    () =>
      archiveRMW((archive) => {
        archive.entries = [...entries, ...archive.entries];
        return archive;
      }),
    "seed-archive",
  );
globalThis.__ttSetMockAi = (mock) => {
  globalThis.__ttMockAi = mock || null;
};

