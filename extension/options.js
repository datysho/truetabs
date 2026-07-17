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
  "groupAuto",
  "smartAutoAssign",
];
const SELECTS = [
  "dedupScope",
  "archiveAfter",
  "archiveTtl",
  "groupCollapseAfter",
  "smartEngine",
  "byokProvider",
  "theme",
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

function renderSmartRows() {
  const engine = $("smartEngine").value;
  $("builtinRow").hidden = engine !== "builtin";
  $("byokRow").hidden = engine !== "byok";
  $("smartAssignRow").hidden = engine === "off";
  const provider = $("byokProvider").value;
  const custom = provider === "custom";
  $("byokBaseUrlLabel").hidden = !custom;
  $("byokBaseUrl").hidden = !custom;
  $("byokModel").placeholder = PROVIDER_MODEL_HINTS[provider] || "";
}

async function refreshBuiltinStatus() {
  const status = await send({ type: "ui:smartStatus" });
  const el = $("builtinStatus");
  const availability = status.availability;
  if (availability === "available") {
    el.textContent = t("smartStatusReady");
    el.className = "hint ok";
    $("smartEnableBtn").hidden = true;
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

async function saveByok() {
  if (!(await ensureByokPermission())) return false;
  await setSetting("byokProvider", $("byokProvider").value);
  await setSetting("byokModel", $("byokModel").value.trim());
  await setSetting("byokBaseUrl", $("byokBaseUrl").value.trim());
  const key = $("byokKey").value.trim();
  if (key && key !== "********") {
    await send({ type: "ui:byokSetKey", key });
  }
  $("byokStatus").textContent = t("byokSaved");
  $("byokStatus").className = "byok-note ok";
  return true;
}

async function init() {
  const state = await send({ type: "ui:getState" });
  settings = state.settings;
  applyTheme(settings.theme);
  await ttI18n.init(settings.language);
  localizeDom();
  $("version").textContent = `v${chrome.runtime.getManifest().version}`;

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
      if (id === "smartEngine" || id === "byokProvider") renderSmartRows();
      if (id === "smartEngine" && e.target.value === "builtin") refreshBuiltinStatus();
    });
  }

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
  if (state.byokKeySet) $("byokKey").value = "********";
  renderSmartRows();
  if (settings.smartEngine === "builtin") refreshBuiltinStatus();

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

  $("byokSaveBtn").addEventListener("click", saveByok);
  $("byokTestBtn").addEventListener("click", async () => {
    $("byokStatus").textContent = t("byokTesting");
    $("byokStatus").className = "byok-note";
    if (!(await saveByok())) return;
    const result = await send({ type: "ui:byokTest" });
    if (result.ok) {
      $("byokStatus").textContent = t("byokTestOk");
      $("byokStatus").className = "byok-note ok";
    } else {
      $("byokStatus").textContent = `${t("byokTestFail")} ${result.error || ""}`.trim();
      $("byokStatus").className = "byok-note err";
    }
  });

  $("diagBtn").addEventListener("click", async () => {
    const dump = await send({ type: "ui:diagnostics" });
    await navigator.clipboard.writeText(JSON.stringify(dump, null, 2));
    $("diagNote").textContent = t("optDiagCopied");
    setTimeout(() => {
      $("diagNote").textContent = "";
    }, 4000);
  });
}

init();
