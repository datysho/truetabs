// TrueTabs - options page. Save-on-change; all state through ui:* messages.
// BYOK host access is requested HERE (chrome.permissions.request needs a
// user gesture on an extension page): saving or testing a key first asks
// for the one origin the chosen provider needs - install-time site access
// stays zero.

const $ = (id) => document.getElementById(id);
const t = (key, subs) => ttI18n.t(key, subs);
const send = (message) => chrome.runtime.sendMessage(message);

const SWITCHES = [
  "dedupAuto",
  "archiveNotify",
  "archiveForeignGroups",
  "discardStale",
  "groupsOnTop",
  "sortAuto",
  "otherGroup",
  "smartRegroupOurs",
];
const SELECTS = [
  "dedupScope",
  "archiveAfter",
  "archiveTtl",
  "autoGroup",
  "groupCollapseAfter",
  "sortGroups",
  "sortTabs",
  "smartEngine",
  "byokProvider",
  "theme",
  "iconStyle",
  "language",
];

// One voice for every transient confirmation - copied, exported, imported,
// failed. A fixed pill outside the layout: nothing reserves a box, nothing
// shifts when it appears, and the same message never renders two ways.
let toastTimer = null;
function showToast(key, isError = false) {
  const el = $("toast");
  el.textContent = t(key);
  el.className = isError ? "toast err show" : "toast show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = isError ? "toast err" : "toast";
  }, 3200);
}

const PROVIDER_ORIGINS = {
  openai: "https://api.openai.com/*",
  gemini: "https://generativelanguage.googleapis.com/*",
  grok: "https://api.x.ai/*",
};
// A custom endpoint is a model server running on this machine (Ollama, LM
// Studio). Keeping the ask to loopback keeps the manifest free of the
// http://*/* + https://*/* pair, which reads as <all_urls> to a reviewer.
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1"];
const PROVIDER_MODEL_HINTS = {
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
  grok: "grok-3-mini",
  custom: "llama3.1",
};

let settings = null;

function applyTheme(v) {
  if (v === "light" || v === "dark") document.documentElement.dataset.theme = v;
  else delete document.documentElement.dataset.theme;
}

function localizeDom() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
}

// The engine answers with the settings it actually holds: the grouping pair
// rule may have moved a second key, and a page that repainted from its own
// optimistic guess would show a state that does not exist.
async function setSetting(key, value) {
  settings[key] = value;
  const res = await send({ type: "ui:setSetting", key, value });
  if (res && res.settings) {
    settings = res.settings;
    for (const id of SELECTS) $(id).value = settings[id];
    for (const id of SWITCHES) $(id).checked = !!settings[id];
  }
  return res;
}

// The order controls are a pair: WHICH order, and whether it is kept live.
// With both orders manual there is nothing to keep live - the switch says so
// instead of pretending to govern something.
function renderSortRows() {
  const manual = $("sortGroups").value === "off" && $("sortTabs").value === "off";
  $("sortAuto").disabled = manual;
  $("sortAutoRow").classList.toggle("dim", manual);
}

function renderSmartRows() {
  const engine = $("smartEngine").value;
  $("builtinRow").hidden = engine !== "builtin";
  $("byokRow").hidden = engine !== "byok";
  $("smartRegroupRow").hidden = engine === "off";
  // Topic mode without an engine falls back to site grouping - say so.
  $("autoGroupNeedsAi").hidden = !($("autoGroup").value === "topic" && engine === "off");
  const provider = $("byokProvider").value;
  const custom = provider === "custom";
  $("byokBaseUrlLabel").hidden = !custom;
  $("byokBaseUrl").hidden = !custom;
  $("byokModel").placeholder = PROVIDER_MODEL_HINTS[provider] || "";
}

// --- custom rule groups editor -------------------------------------------------
// One bordered item per rule: name, the sites that always route there, and an
// optional AI hint. Saves on change like everything else; the list is only
// re-rendered on add/remove so typing focus is never stolen.

let customGroups = [];

function collectCustomGroups() {
  return [...document.querySelectorAll(".custom-item")]
    .map((item) => ({
      id: item.dataset.id,
      name: item.querySelector(".c-name").value.trim(),
      domains: item
        .querySelector(".c-domains")
        .value.split(/[\s,;]+/)
        .map((d) => d.trim())
        .filter(Boolean),
      hint: item.querySelector(".c-hint").value.trim(),
      on: item.querySelector(".c-on").checked,
    }))
    .filter((g) => g.name);
}

async function saveCustomGroups() {
  const result = await send({ type: "ui:customGroups:set", list: collectCustomGroups() });
  if (result && result.ok) {
    customGroups = result.customGroups;
    $("customNote").textContent = "";
  } else {
    $("customNote").textContent = t("customTooBig");
  }
}

function customRow(rule) {
  const item = document.createElement("div");
  item.className = "custom-item";
  item.dataset.id = rule.id;

  const name = document.createElement("input");
  name.type = "text";
  name.className = "c-name";
  name.value = rule.name;
  name.placeholder = t("customNamePh");
  item.appendChild(name);

  const on = document.createElement("input");
  on.type = "checkbox";
  on.className = "switch c-on";
  on.checked = rule.on !== false;
  item.appendChild(on);

  const remove = document.createElement("button");
  remove.className = "linklike";
  remove.textContent = t("customRemove");
  remove.addEventListener("click", async () => {
    item.remove();
    await saveCustomGroups();
    renderCustomList();
  });
  item.appendChild(remove);

  const domains = document.createElement("input");
  domains.type = "text";
  domains.className = "c-domains full";
  domains.value = (rule.domains || []).join(", ");
  domains.placeholder = t("customDomainsPh");
  domains.spellcheck = false;
  item.appendChild(domains);

  const hint = document.createElement("input");
  hint.type = "text";
  hint.className = "c-hint full";
  hint.value = rule.hint || "";
  hint.placeholder = t("customHintPh");
  item.appendChild(hint);

  for (const el of [name, on, domains, hint]) el.addEventListener("change", saveCustomGroups);
  return item;
}

function renderCustomList() {
  const list = $("customList");
  list.textContent = "";
  for (const rule of customGroups) list.appendChild(customRow(rule));
  $("customAddBtn").hidden = customGroups.length >= 10;
}

async function refreshBuiltinStatus() {
  const status = await send({ type: "ui:smartStatus" });
  const el = $("builtinStatus");
  const availability = status.availability;
  $("builtinManaged").hidden = true;
  if (availability === "available") {
    el.textContent = t("smartStatusReady");
    el.className = "hint ok";
    $("smartEnableBtn").hidden = true;
    $("builtinManaged").hidden = false; // model is Chrome's: how to remove it
  } else if (availability === "downloadable" || availability === "downloading") {
    el.textContent = t("smartStatusDownloadable");
    el.className = "hint";
    $("smartEnableBtn").hidden = false;
  } else {
    el.textContent = t("smartStatusUnavailable");
    el.className = "hint err";
    $("smartEnableBtn").hidden = true;
  }
}

function refreshByokWarning() {
  $("byokWarn").hidden = !($("smartEngine").value === "byok" && !byokKeyPresent);
}

// Which single origin the current BYOK setup needs, or null if the fields do
// not name a usable one. The manifest's optional_host_permissions is the
// ceiling of what may ever be asked for: three named providers plus loopback,
// nothing wider - so a custom endpoint must be a LOCAL model server.
function byokOriginPattern(provider, baseUrl) {
  if (provider !== "custom") return PROVIDER_ORIGINS[provider] || null;
  let url;
  try {
    url = new URL((baseUrl || "").trim());
  } catch {
    return null;
  }
  if (!LOOPBACK_HOSTS.includes(url.hostname)) return "not-local";
  return `${url.origin}/*`;
}

// The one runtime permission ask: the origin of the chosen provider (or the
// local endpoint's own origin). Returns true when granted.
async function ensureByokPermission() {
  const pattern = byokOriginPattern($("byokProvider").value, $("byokBaseUrl").value);
  if (!pattern || pattern === "not-local") {
    $("byokStatus").textContent = t(pattern === "not-local" ? "byokLocalOnly" : "byokBadUrl");
    $("byokStatus").className = "byok-note err";
    return false;
  }
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) {
    $("byokStatus").textContent = t("byokPermDenied");
    $("byokStatus").className = "byok-note err";
  }
  return granted;
}

// Access granted for one provider must not outlive the choice: switching
// provider or clearing the key hands the old origin back. Only origins this
// extension could have asked for are ever touched (the manifest's ceiling),
// and never the one currently in use - so "zero site access unless you use
// BYOK" stays true over time, not just on install day.
async function releaseUnusedByokOrigins(keep) {
  const { origins = [] } = await chrome.permissions.getAll();
  const askable = chrome.runtime.getManifest().optional_host_permissions || [];
  const stale = origins.filter((o) => o !== keep && askable.includes(o));
  // A loopback grant is not in the manifest verbatim (the port is the user's),
  // so match those by host instead of by pattern.
  for (const o of origins) {
    if (o === keep || stale.includes(o)) continue;
    try {
      if (LOOPBACK_HOSTS.includes(new URL(o.replace(/\*$/, "")).hostname)) stale.push(o);
    } catch {
      /* not a URL-shaped pattern: leave it alone */
    }
  }
  if (stale.length) await chrome.permissions.remove({ origins: stale });
}

// BYOK fields auto-save like every other setting. The one special moment is
// the key itself: saving it (change/blur = a user gesture) also asks for the
// single host permission the chosen provider needs.
let byokKeyPresent = false;

async function saveByokFields() {
  await setSetting("byokProvider", $("byokProvider").value);
  await setSetting("byokModel", $("byokModel").value.trim());
  await setSetting("byokBaseUrl", $("byokBaseUrl").value.trim());
}

async function saveByokKey() {
  const key = $("byokKey").value.trim();
  if (!key || key === "********") return;
  await saveByokFields();
  await send({ type: "ui:byokSetKey", key });
  byokKeyPresent = true;
  refreshByokWarning();
  const granted = await ensureByokPermission();
  if (granted) {
    $("byokStatus").textContent = t("byokSaved");
    $("byokStatus").className = "byok-note ok";
    // The provider may have changed with this save: the previous one's origin
    // has no reason to stay granted.
    await releaseUnusedByokOrigins(byokOriginPattern($("byokProvider").value, $("byokBaseUrl").value));
  }
}

// Everything on this page paints from STORAGE, not from the engine: stored
// settings are always normalized on write, so they are the truth for every
// control - real values on the first frame, no engine roundtrip, no flicker.
function paintControls() {
  for (const id of SWITCHES) {
    $(id).checked = !!settings[id];
    $(id).addEventListener("change", (e) => setSetting(id, e.target.checked));
  }
  for (const id of SELECTS) {
    $(id).value = settings[id];
    $(id).addEventListener("change", async (e) => {
      await setSetting(id, e.target.value);
      if (id === "theme") applyTheme(e.target.value);
      if (id === "language") location.reload();
      if (id === "smartEngine" || id === "byokProvider" || id === "autoGroup") {
        renderSmartRows();
        refreshByokWarning();
      }
      // Turning BYOK off, or picking another provider, retires the old grant.
      if (id === "smartEngine" || id === "byokProvider") {
        await releaseUnusedByokOrigins(
          settings.smartEngine === "byok"
            ? byokOriginPattern($("byokProvider").value, $("byokBaseUrl").value)
            : null,
        );
      }
      if (id === "sortGroups" || id === "sortTabs") renderSortRows();
      if (settings.smartEngine === "builtin") refreshBuiltinStatus();
    });
  }

  renderCustomList();
  $("customAddBtn").addEventListener("click", () => {
    customGroups.push({ id: crypto.randomUUID(), name: "", domains: [], hint: "", on: true });
    renderCustomList();
    const rows = document.querySelectorAll(".custom-item .c-name");
    rows[rows.length - 1].focus();
  });

  $("archiveAllowlist").value = (settings.archiveAllowlist || []).join("\n");
  $("archiveAllowlist").addEventListener("change", (e) => {
    const domains = e.target.value
      .split("\n")
      .map((line) => line.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .filter(Boolean);
    e.target.value = domains.join("\n");
    setSetting("archiveAllowlist", domains);
  });

  // Protected groups: one title per line; automation never removes tabs from
  // them. The popup rows carry the same lock as a one-click action.
  $("protectedGroups").value = (settings.protectedGroups || []).join("\n");
  $("protectedGroups").addEventListener("change", (e) => {
    const titles = e.target.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    e.target.value = titles.join("\n");
    setSetting("protectedGroups", titles);
  });

  // Bookmark groups: the toggle IS the permission flow. Switching on asks
  // Chrome for the optional bookmarks permission inside this click (denial
  // reverts the switch); switching off releases the grant - the mirror of
  // the BYOK origin release: a grant without use is standing debt.
  $("bookmarkGroups").checked = !!settings.bookmarkGroups;
  $("bookmarkGroups").addEventListener("change", async (e) => {
    if (e.target.checked) {
      const granted = await chrome.permissions
        .request({ permissions: ["bookmarks"] })
        .catch(() => false);
      if (!granted) {
        e.target.checked = false;
        return;
      }
      setSetting("bookmarkGroups", true);
    } else {
      setSetting("bookmarkGroups", false);
      chrome.permissions.remove({ permissions: ["bookmarks"] }).catch(() => {});
    }
  });

  // --- backup: export / import ----------------------------------------------
  // One clean JSON file: settings + My groups. The BYOK key rides only behind
  // the explicit include toggle (export) and a second confirmation (import) -
  // a plaintext key is a deliberate double-opted step, never a side effect.
  $("exportBtn").addEventListener("click", async () => {
    const payload = await send({
      type: "ui:exportData",
      includeKey: $("exportWithKey").checked,
    });
    if (!payload || payload.error) return showToast("dataFailed", true);
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `truetabs-settings-${payload.version}-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast("dataExported");
  });

  $("importBtn").addEventListener("click", () => $("importFile").click());

  $("importFile").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // re-selecting the same file must fire again
    if (!file) return;
    if (file.size > 64 * 1024) return showToast("dataFailed", true);
    let parsed = null;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      return showToast("dataFailed", true);
    }
    const withKey =
      typeof parsed?.byokKey === "string" && parsed.byokKey
        ? window.confirm(t("dataImportKeyConfirm"))
        : false;
    const result = await send({ type: "ui:importData", payload: parsed, withKey });
    if (!result || !result.ok) return showToast("dataFailed", true);
    location.reload(); // repaint every control from the imported truth
  });

  $("byokModel").value = settings.byokModel || "";
  $("byokBaseUrl").value = settings.byokBaseUrl || "";
  if (byokKeyPresent) $("byokKey").value = "********";
  renderSmartRows();
  renderSortRows();
  refreshByokWarning();

  // Auto-save on change - same contract as every other control on this page.
  $("byokKey").addEventListener("change", saveByokKey);
  $("byokModel").addEventListener("change", saveByokFields);
  $("byokBaseUrl").addEventListener("change", async () => {
    await saveByokFields();
    if (byokKeyPresent) await ensureByokPermission();
  });

  $("smartEnableBtn").addEventListener("click", async () => {
    $("smartEnableBtn").disabled = true;
    $("smartProgress").textContent = t("smartDownloading");
    const onProgress = (changes, area) => {
      if (area !== "session" || !changes.smartDownload) return;
      const v = changes.smartDownload.newValue;
      if (v && v.total) {
        $("smartProgress").textContent = `${t("smartDownloading")} ${Math.round(
          (v.loaded / v.total) * 100,
        )}%`;
      }
    };
    chrome.storage.onChanged.addListener(onProgress);
    const result = await send({ type: "ui:smartEnable" });
    chrome.storage.onChanged.removeListener(onProgress);
    $("smartProgress").textContent = "";
    $("smartEnableBtn").disabled = false;
    await refreshBuiltinStatus();
    if (result.status !== "available" && result.error) {
      $("builtinStatus").textContent = result.error;
      $("builtinStatus").className = "hint err";
    }
  });

  $("byokTestBtn").addEventListener("click", async () => {
    $("byokStatus").textContent = t("byokTesting");
    $("byokStatus").className = "byok-note";
    await saveByokKey(); // also re-requests permission if it was denied
    await saveByokFields();
    if (!(await ensureByokPermission())) return;
    const result = await send({ type: "ui:byokTest" });
    if (result.ok) {
      $("byokStatus").textContent = t("byokTestOk");
      $("byokStatus").className = "byok-note ok";
    } else {
      $("byokStatus").textContent = `${t("byokTestFail")} ${result.error || ""}`.trim();
      $("byokStatus").className = "byok-note err";
    }
  });

  // chrome:// pages can't be plain hrefs, but extensions may open them.
  $("onDeviceLink").addEventListener("click", (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: "chrome://on-device-internals" });
  });

  // Diagnostics must survive its own failure modes: the dump is fetched
  // off-queue (fast, so the click's user activation is still valid when the
  // clipboard write happens), and if the write is refused anyway the JSON
  // lands in a selectable box instead of the button doing nothing at all.
  $("diagBtn").addEventListener("click", async () => {
    $("diagDump").hidden = true;
    let text;
    try {
      const dump = await send({ type: "ui:diagnostics" });
      if (!dump || dump.error) throw new Error((dump && dump.error) || "no response");
      text = JSON.stringify(dump, null, 2);
    } catch (err) {
      return showToast("engineDownBody", true);
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast("optDiagCopied");
    } catch {
      $("diagDump").value = text;
      $("diagDump").hidden = false;
      $("diagDump").select();
      showToast("optDiagFailed", true);
    }
  });
}

// Two-stage boot.
// Stage 1 never touches the engine: settings, rules and the BYOK-key flag
// come straight from storage, every control gets its REAL value, the page
// localizes and only then reveals - the first painted frame is already
// correct, whatever the engine is doing.
// Stage 2 is a health probe: a short ping decides between live extras (the
// built-in AI status) and the engine-down card with recovery.
async function boot() {
  let stored = {};
  try {
    stored = await chrome.storage.sync.get(["settings", "customGroups"]);
  } catch {}
  settings = ttSchema.normalizeSettings(stored.settings);
  customGroups = ttSchema.normalizeCustomGroups(stored.customGroups);
  applyTheme(settings.theme);
  await ttI18n.init(settings.language);
  localizeDom();
  $("version").textContent = `v${chrome.runtime.getManifest().version}`;
  try {
    byokKeyPresent = !!(await chrome.storage.local.get("byokKey")).byokKey;
  } catch {}
  try {
    paintControls();
  } finally {
    document.body.classList.add("ready"); // reveal even if painting hiccuped
  }

  const pong = await Promise.race([
    send({ type: "ui:ping" }).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
  ]);
  if (!pong || !pong.ok) {
    $("engineDown").hidden = false;
    for (const el of document.querySelectorAll("input, select, textarea, button")) {
      if (el.id !== "engineResetBtn") el.disabled = true;
    }
    $("engineResetBtn").addEventListener("click", async () => {
      await chrome.storage.sync.remove(["settings", "customGroups"]);
      location.reload();
    });
    return;
  }
  if (settings.smartEngine === "builtin") refreshBuiltinStatus();
}

boot();
