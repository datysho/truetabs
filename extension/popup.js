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

  // Organize speaks the active engine: with smart grouping on, the button IS
  // Smart Organize (it falls back to site grouping by itself).
  $("organizeBtn").textContent =
    state.settings.smartEngine !== "off" ? t("actSmartOrganize") : t("actOrganize");

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
  const undoOrgRow = $("undoOrgRow");
  if (state.lastOrganize && state.lastOrganize.gids.length > 0) {
    undoOrgRow.hidden = false;
    $("undoOrgText").textContent = t("undoOrgText", [state.lastOrganize.gids.length]);
  } else {
    undoOrgRow.hidden = true;
  }
  renderGroups();
}

// --- groups section: jump, fold, drag-reorder --------------------------------

let dragGid = null;

function groupRow(group) {
  const row = document.createElement("div");
  row.className = "group-row";
  row.draggable = true;

  const dot = document.createElement("span");
  dot.className = `dot gc-${group.color}`;
  row.appendChild(dot);

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = group.title || t("groupUntitled");
  row.appendChild(name);

  const count = document.createElement("span");
  count.className = "count";
  count.textContent = ttI18n.tabsCount(group.tabCount);
  row.appendChild(count);

  const fold = document.createElement("button");
  fold.className = `fold${group.collapsed ? " folded" : ""}`;
  fold.title = t(group.collapsed ? "groupExpand" : "groupCollapse");
  fold.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  fold.addEventListener("click", (event) => {
    event.stopPropagation();
    send({ type: "ui:groupCollapse", gid: group.id, collapsed: !group.collapsed }).then(refresh);
  });
  row.appendChild(fold);

  row.addEventListener("click", () => {
    send({ type: "ui:groupFocus", gid: group.id }); // sync dispatch; popup may die
  });

  row.addEventListener("dragstart", () => {
    dragGid = group.id;
    row.classList.add("dragging");
  });
  row.addEventListener("dragend", () => {
    dragGid = null;
    row.classList.remove("dragging");
  });
  row.addEventListener("dragover", (event) => {
    if (dragGid == null || dragGid === group.id) return;
    event.preventDefault();
    row.classList.add("drop-above");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-above"));
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    row.classList.remove("drop-above");
    if (dragGid == null || dragGid === group.id) return;
    const source = state.groups.find((g) => g.id === dragGid);
    if (!source || source.windowId !== group.windowId) return; // same-window reorder only
    send({
      type: "ui:groupMove",
      gid: dragGid,
      windowId: group.windowId,
      index: groupStripIndex(group),
    }).then(refresh);
  });

  return row;
}

// Target index for tabGroups.move: the first tab index of the drop target.
function groupStripIndex(group) {
  return group.firstTabIndex ?? -1;
}

function renderGroups() {
  const section = $("groupsSection");
  const groups = state.groups || [];
  section.hidden = groups.length === 0;
  if (!groups.length) return;
  $("groupsCount").textContent = groups.length;
  const list = $("groupList");
  list.textContent = "";
  for (const group of groups) list.appendChild(groupRow(group));
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
  $("organizeBtn").addEventListener("click", () => {
    const smart = state && state.settings.smartEngine !== "off";
    const promise = send({
      type: smart ? "ui:smartOrganize" : "ui:organizeNow",
      scope: "window",
      windowId,
    });
    $("organizeBtn").disabled = true;
    promise
      .then((r) => {
        setStatus(t("statusOrganized", [r.grouped, r.groupsCreated]));
        return refresh();
      })
      .finally(() => {
        $("organizeBtn").disabled = false;
      });
  });
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
  $("undoOrgBtn").addEventListener("click", () => {
    send({ type: "ui:undoOrganize" }).then((r) => {
      setStatus(t("statusUngrouped", [r.ungrouped]));
      refresh();
    });
  });
  $("collapseAllBtn").addEventListener("click", () => {
    send({ type: "ui:groupsCollapseAll", collapsed: true }).then(refresh);
  });
  $("expandAllBtn").addEventListener("click", () => {
    send({ type: "ui:groupsCollapseAll", collapsed: false }).then(refresh);
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
