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
  $("dupeCount").classList.toggle("attention", c.dupes > 0);
  $("staleCount").textContent = c.staleNow;
  $("archivedCount").textContent = c.archivedToday;

  $("dedupToggle").checked = !!state.settings.dedupAuto;
  $("archiveToggle").checked = state.settings.archiveAfter !== "off";
  $("groupToggle").checked = state.settings.autoGroup !== "off";

  // Organize speaks the active engine: with smart grouping on, the button IS
  // Smart Organize (it falls back to site grouping by itself).
  $("organizeBtn").textContent =
    state.settings.smartEngine !== "off" ? t("actSmartOrganize") : t("actOrganize");

  const warming = $("warming");
  if (state.smartProgress && state.smartProgress.total > 0) {
    warming.textContent = t("smartWorking", [state.smartProgress.done, state.smartProgress.total]);
    $("organizeBtn").disabled = true;
  } else {
    $("organizeBtn").disabled = false;
    if (state.paused) warming.textContent = t("pausedNote");
    else if (!state.settled) warming.textContent = t("warmingNote");
    else warming.textContent = "";
  }

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
// Dragging reorders the LIST LIVE under the cursor (the row follows the
// pointer, others give way); the drop commits the final order to the strip.

let dragGid = null;
let dragWindowId = null;
let dragDropped = false;

function groupRow(group) {
  const row = document.createElement("div");
  row.className = "group-row";
  row.dataset.gid = String(group.id);
  row.dataset.windowId = String(group.windowId);

  // Drag by the grip only: a row click means "jump to the group". Under an
  // active group sort the order is managed - dragging would just snap back,
  // so the grip disappears instead of lying.
  const managed = state && state.settings.sortGroups !== "off";
  const grip = document.createElement("span");
  grip.className = "grip";
  grip.draggable = !managed;
  grip.hidden = managed;
  grip.title = t("groupDragTitle");
  grip.addEventListener("click", (event) => event.stopPropagation());
  grip.addEventListener("dragstart", (event) => {
    event.stopPropagation();
    dragGid = group.id;
    dragWindowId = group.windowId;
    dragDropped = false;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setDragImage(row, 16, 15); // the whole row travels, not the grip
    row.classList.add("dragging");
    $("groupList").classList.add("drag-live");
  });
  grip.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    $("groupList").classList.remove("drag-live");
    dragGid = null;
    dragWindowId = null;
    if (!dragDropped) refresh(); // dropped outside: snap the list back
  });
  row.appendChild(grip);

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

  // Words, not glyphs: Fold/Unfold + Ungroup, shown on hover in the count's place.
  const actions = document.createElement("span");
  actions.className = "row-actions";
  const fold = document.createElement("button");
  fold.textContent = t(group.collapsed ? "groupExpand" : "groupCollapse");
  fold.addEventListener("click", (event) => {
    event.stopPropagation();
    send({ type: "ui:groupCollapse", gid: group.id, collapsed: !group.collapsed }).then(refresh);
  });
  actions.appendChild(fold);
  const ungroup = document.createElement("button");
  ungroup.textContent = t("groupUngroup");
  ungroup.addEventListener("click", (event) => {
    event.stopPropagation();
    send({ type: "ui:groupUngroup", gid: group.id }).then((r) => {
      setStatus(t("statusUngrouped", [r.ungrouped]));
      refresh();
    });
  });
  actions.appendChild(ungroup);
  row.appendChild(actions);

  row.addEventListener("click", () => {
    send({ type: "ui:groupFocus", gid: group.id }); // sync dispatch; popup may die
  });

  return row;
}

// Live reorder: as the cursor moves over the list, the dragged row slots in
// where it would land - within its own window's cluster only.
function onListDragOver(event) {
  if (dragGid == null) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const list = $("groupList");
  const dragging = list.querySelector(".group-row.dragging");
  if (!dragging) return;
  const siblings = [...list.querySelectorAll(".group-row:not(.dragging)")].filter(
    (r) => Number(r.dataset.windowId) === dragWindowId,
  );
  if (!siblings.length) return;
  let before = null;
  for (const row of siblings) {
    const rect = row.getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) {
      before = row;
      break;
    }
  }
  if (before) {
    if (before !== dragging.nextElementSibling) list.insertBefore(dragging, before);
  } else {
    const last = siblings[siblings.length - 1];
    if (dragging !== last.nextElementSibling && dragging.previousElementSibling !== last) {
      list.insertBefore(dragging, last.nextSibling);
    }
  }
}

function onListDrop(event) {
  if (dragGid == null) return;
  event.preventDefault();
  dragDropped = true;
  const windowId = dragWindowId;
  const gids = [...$("groupList").querySelectorAll(".group-row")]
    .filter((r) => Number(r.dataset.windowId) === windowId)
    .map((r) => Number(r.dataset.gid));
  send({ type: "ui:groupReorder", windowId, gids }).then(refresh);
}

function renderGroups() {
  const section = $("groupsSection");
  const groups = state.groups || [];
  section.hidden = groups.length === 0;
  if (!groups.length) return;
  $("groupsCount").textContent = groups.length;
  const list = $("groupList");
  if (list.querySelector(".group-row.dragging")) return; // never repaint mid-drag
  list.textContent = "";
  for (const group of groups) list.appendChild(groupRow(group));
}

async function refresh() {
  const next = await send({ type: "ui:getState", windowId });
  if (next && next.settings) {
    state = next;
    render();
  }
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
  const first = await send({ type: "ui:getState" });
  if (!first || !first.settings) throw new Error("engine did not respond");

  const win = await chrome.windows.getCurrent();
  windowId = win.id;

  initFooter();
  $("groupList").addEventListener("dragover", onListDragOver);
  $("groupList").addEventListener("drop", onListDrop);
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
  // Ungroup all dissolves every group in every window - ask twice (TruePin's
  // "sure?" pill pattern): first click arms, second within 3s fires.
  $("ungroupAllBtn").addEventListener("click", () => {
    const btn = $("ungroupAllBtn");
    if (!btn.classList.contains("confirm")) {
      btn.classList.add("confirm");
      btn.textContent = t("ungroupAllConfirm");
      setTimeout(() => {
        btn.classList.remove("confirm");
        btn.textContent = t("ungroupAll");
      }, 3000);
      return;
    }
    btn.classList.remove("confirm");
    btn.textContent = t("ungroupAll");
    send({ type: "ui:groupsUngroupAll" }).then((r) => {
      setStatus(t("statusUngrouped", [r.ungrouped]));
      refresh();
    });
  });
  wireToggle("dedupToggle", "dedupAuto", (checked) => checked);
  // Grouping toggle re-enables the mode the engine can honor: topic when an
  // AI tier is configured, otherwise by site.
  $("groupToggle").addEventListener("change", (event) => {
    const value = !event.target.checked
      ? "off"
      : state && state.settings.smartEngine !== "off"
        ? "topic"
        : "site";
    send({ type: "ui:setSetting", key: "autoGroup", value }).then(refresh);
  });
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

// Stage 1: paint everything storage already knows - toggles, the organize
// button's identity, today's archive counter, both undo rows, smart progress.
// Stored settings are normalized on write, so these are REAL values: the
// first painted frame is correct and nothing flips later. Counters that need
// the live tab world stay "-" until the engine answers - a fill, not a flip.
function localDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

async function prePaint() {
  const [syncBag, localBag, sessionBag] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get(["counters", "lastBatch"]),
    chrome.storage.session.get(["lastOrganize", "smartProgress"]),
  ]);
  const s = ttSchema.normalizeSettings(syncBag.settings);
  applyTheme(s.theme);
  await ttI18n.init(s.language);
  localizeDom();

  $("dedupToggle").checked = !!s.dedupAuto;
  $("archiveToggle").checked = s.archiveAfter !== "off";
  $("groupToggle").checked = s.autoGroup !== "off";
  $("organizeBtn").textContent =
    s.smartEngine !== "off" ? t("actSmartOrganize") : t("actOrganize");
  const counters = localBag.counters;
  $("archivedCount").textContent =
    counters && counters.date === localDate(Date.now()) ? counters.archivedToday || 0 : 0;
  if (localBag.lastBatch && localBag.lastBatch.count > 0) {
    $("undoRow").hidden = false;
    $("undoText").textContent = t("undoRowText", [localBag.lastBatch.count]);
  }
  const lastOrganize = sessionBag.lastOrganize;
  if (lastOrganize && lastOrganize.gids.length > 0) {
    $("undoOrgRow").hidden = false;
    $("undoOrgText").textContent = t("undoOrgText", [lastOrganize.gids.length]);
  }
  const progress = sessionBag.smartProgress;
  if (progress && progress.total > 0) {
    $("warming").textContent = t("smartWorking", [progress.done, progress.total]);
    $("organizeBtn").disabled = true;
  }
}

// Boot: stage 1 paints from storage and reveals; stage 2 talks to the engine
// (live counts, group list) - its failure shows a plain, localized notice on
// an otherwise fully painted page, never a blank or wrong-state skeleton.
async function boot() {
  try {
    await prePaint();
  } catch {
    await ttI18n.init("auto");
    localizeDom();
  } finally {
    document.body.classList.add("ready");
  }
  try {
    await init();
  } catch (err) {
    const down = $("engineDown");
    down.hidden = false;
    down.textContent = t("engineDownBody");
    console.error("TrueTabs popup init failed:", err);
  }
}

boot();
