// TrueTabs - popup. All logic lives in the service worker; the popup only
// renders ui:getState and sends ui:* commands. Every click dispatches its
// message SYNCHRONOUSLY: an MV3 action popup is destroyed the moment focus
// leaves it, so nothing may await before the sendMessage call.

let windowId = null;
let state = null;

const $ = (id) => document.getElementById(id);
const t = (key, subs) => ttI18n.t(key, subs);
const send = (message) => chrome.runtime.sendMessage(message);

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

function setStatus(text, isError) {
  const el = $("status");
  el.textContent = text || "";
  el.className = isError ? "err" : "";
}

function render() {
  if (!state) return;
  const c = state.counts;
  $("tabCount").textContent = c.tabs;
  $("winCount").textContent = c.windows > 1 ? t("inWindows", [c.windows]) : "";
  $("dupeCount").textContent = c.dupes;
  $("staleCount").textContent = c.staleNow;
  $("archivedCount").textContent = c.archivedToday;

  $("dedupToggle").checked = !!state.settings.dedupAuto;
  $("archiveToggle").checked = state.settings.archiveAfter !== "off";
  $("groupToggle").checked = !!state.settings.groupAuto;

  const warming = $("warming");
  if (state.paused) warming.textContent = t("pausedNote");
  else if (!state.settled) warming.textContent = t("warmingNote");
  else warming.textContent = "";

  const undoRow = $("undoRow");
  if (state.lastBatch && state.lastBatch.count > 0) {
    undoRow.hidden = false;
    $("undoText").textContent = t("undoRowText", [state.lastBatch.count]);
  } else {
    undoRow.hidden = true;
  }
}

async function refresh() {
  state = await send({ type: "ui:getState", windowId });
  render();
}

// Action buttons: dispatch first, then refresh on the response promise.
function wireAction(id, message, report) {
  $(id).addEventListener("click", () => {
    const promise = send({ ...message, windowId }); // synchronous dispatch
    $(id).disabled = true;
    promise
      .then((result) => {
        setStatus(report(result));
        return refresh();
      })
      .finally(() => {
        $(id).disabled = false;
      });
  });
}

function wireToggle(id, key, valueOf) {
  $(id).addEventListener("change", (event) => {
    send({ type: "ui:setSetting", key, value: valueOf(event.target.checked) }).then(refresh);
  });
}

function initFooter() {
  const wire = (id, url) => {
    if (!url) {
      $(id).hidden = true;
    } else {
      $(id).addEventListener("click", () => chrome.tabs.create({ url }));
    }
  };
  $("archivePageBtn").addEventListener("click", () =>
    chrome.tabs.create({ url: chrome.runtime.getURL("archive.html") }),
  );
  wire("githubBtn", typeof TT_GITHUB_URL === "undefined" ? "" : TT_GITHUB_URL);
  wire("reviewBtn", typeof TT_REVIEW_URL === "undefined" ? "" : TT_REVIEW_URL);
  wire("donateBtn", typeof TT_PAYPAL_URL === "undefined" ? "" : TT_PAYPAL_URL);
  $("openOptions").addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

async function init() {
  const settings = (await send({ type: "ui:getState" })).settings;
  applyTheme(settings.theme);
  await ttI18n.init(settings.language);
  localizeDom();

  const win = await chrome.windows.getCurrent();
  windowId = win.id;

  initFooter();
  wireAction("organizeBtn", { type: "ui:organizeNow", scope: "window" }, (r) =>
    t("statusOrganized", [r.grouped, r.groupsCreated]),
  );
  wireAction("sweepBtn", { type: "ui:sweepDupes", scope: "all" }, (r) =>
    t("statusSwept", [r.closed]),
  );
  wireAction("archiveNowBtn", { type: "ui:archiveStaleNow" }, (r) =>
    t("statusArchived", [r.archived]),
  );
  $("mergeBtn").addEventListener("click", () => {
    const promise = send({ type: "ui:mergeWindows", targetWindowId: windowId });
    $("mergeBtn").disabled = true;
    promise
      .then((r) => {
        setStatus(t("statusMerged", [r.moved]));
        return refresh();
      })
      .finally(() => {
        $("mergeBtn").disabled = false;
      });
  });
  $("undoBtn").addEventListener("click", () => {
    send({ type: "ui:undoLastBatch" }).then((r) => {
      setStatus(t("statusRestored", [r.restored]));
      refresh();
    });
  });
  wireToggle("dedupToggle", "dedupAuto", (checked) => checked);
  wireToggle("groupToggle", "groupAuto", (checked) => checked);
  $("archiveToggle").addEventListener("change", (event) => {
    send({
      type: "ui:setSetting",
      key: "archiveAfter",
      value: event.target.checked ? "24h" : "off",
    }).then(refresh);
  });

  await refresh();

  // Live refresh while the popup is open (counters land after our actions).
  chrome.storage.onChanged.addListener(() => {
    clearTimeout(init._debounce);
    init._debounce = setTimeout(refresh, 150);
  });
}

init();
