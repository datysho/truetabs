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
  "smartOther",
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

const PROVIDER_ORIGINS = {
  openai: "https://api.openai.com/*",
  gemini: "https://generativelanguage.googleapis.com/*",
  grok: "https://api.x.ai/*",
};
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

function setSetting(key, value) {
  settings[key] = value;
  return send({ type: "ui:setSetting", key, value });
}

// "Group new tabs: by topic" and "Group by topic using: <engine>" are one
// decision seen from two sides - they move together. Picking an engine turns
// topic grouping on; turning the engine off drops grouping back to site;
// choosing topic with no engine auto-picks the built-in one.
async function syncGroupingPair(changed) {
  if (changed === "autoGroup") {
    if ($("autoGroup").value === "topic" && $("smartEngine").value === "off") {
      $("smartEngine").value = "builtin";
      await setSetting("smartEngine", "builtin");
      refreshBuiltinStatus();
    }
    return;
  }
  if (changed === "smartEngine") {
    const engine = $("smartEngine").value;
    if (engine === "off" && $("autoGroup").value === "topic") {
      $("autoGroup").value = "site";
      await setSetting("autoGroup", "site");
    } else if (engine !== "off" && $("autoGroup").value !== "topic") {
      $("autoGroup").value = "topic";
      await setSetting("autoGroup", "topic");
    }
  }
}

function renderSmartRows() {
  const engine = $("smartEngine").value;
  $("builtinRow").hidden = engine !== "builtin";
  $("byokRow").hidden = engine !== "byok";
  $("smartOtherRow").hidden = engine === "off";
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

// The one runtime permission ask: the origin of the chosen provider (or the
// custom endpoint's own origin). Returns true when granted.
async function ensureByokPermission() {
  const provider = $("byokProvider").value;
  let pattern = PROVIDER_ORIGINS[provider];
  if (provider === "custom") {
    try {
      const url = new URL($("byokBaseUrl").value.trim());
      pattern = `${url.origin}/*`;
    } catch {
      $("byokStatus").textContent = t("byokBadUrl");
      $("byokStatus").className = "byok-note err";
      return false;
    }
  }
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) {
    $("byokStatus").textContent = t("byokPermDenied");
    $("byokStatus").className = "byok-note err";
  }
  return granted;
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
      if (id === "smartEngine" || id === "autoGroup") await syncGroupingPair(id);
      if (id === "smartEngine" || id === "byokProvider" || id === "autoGroup") {
        renderSmartRows();
        refreshByokWarning();
      }
      if (id === "smartEngine" && e.target.value === "builtin") refreshBuiltinStatus();
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

  $("byokModel").value = settings.byokModel || "";
  $("byokBaseUrl").value = settings.byokBaseUrl || "";
  if (byokKeyPresent) $("byokKey").value = "********";
  renderSmartRows();
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
    $("diagNote").textContent = "";
    $("diagDump").hidden = true;
    let text;
    try {
      const dump = await send({ type: "ui:diagnostics" });
      if (!dump || dump.error) throw new Error((dump && dump.error) || "no response");
      text = JSON.stringify(dump, null, 2);
    } catch (err) {
      $("diagNote").textContent = t("engineDownBody");
      $("diagNote").className = "note err";
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      $("diagNote").className = "note";
      $("diagNote").textContent = t("optDiagCopied");
      setTimeout(() => {
        $("diagNote").textContent = "";
      }, 4000);
    } catch {
      $("diagDump").value = text;
      $("diagDump").hidden = false;
      $("diagDump").select();
      $("diagNote").className = "note err";
      $("diagNote").textContent = t("optDiagFailed");
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
