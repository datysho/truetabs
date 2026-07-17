// TrueTabs - archive page. Thin renderer over ui:archive:* messages.
// Day-grouped, searchable, restore/delete one, per-day or by selection.
// Restoring more than 25 at once asks an inline confirm (create-breaker
// awareness: bulk restores declare their allowance, but a misclick that
// opens 200 tabs is still a misclick).

const $ = (id) => document.getElementById(id);
const t = (key, subs) => ttI18n.t(key, subs);
const send = (message) => chrome.runtime.sendMessage(message);

const CONFIRM_OVER = 25;
let entries = [];
const selected = new Set();

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
}

function favicon(url) {
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", url);
  u.searchParams.set("size", "16");
  return u.toString();
}

function dayLabel(dateStr) {
  const today = new Date();
  const localDate = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (dateStr === localDate(today)) return t("archiveToday");
  const yesterday = new Date(today.getTime() - 86400e3);
  if (dateStr === localDate(yesterday)) return t("archiveYesterday");
  return dateStr;
}

function localDateStr(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

async function confirmed(count) {
  return count <= CONFIRM_OVER || window.confirm(t("archiveConfirmMany", [count]));
}

async function restoreIds(ids) {
  if (!ids.length || !(await confirmed(ids.length))) return;
  await send({ type: "ui:archive:restore", ids });
  await refresh();
}

async function deleteIds(ids) {
  if (!ids.length) return;
  await send({ type: "ui:archive:delete", ids });
  await refresh();
}

function entryRow(entry) {
  const row = document.createElement("div");
  row.className = "entry";

  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = selected.has(entry.id);
  check.addEventListener("change", () => {
    if (check.checked) selected.add(entry.id);
    else selected.delete(entry.id);
    renderSelbar();
  });
  row.appendChild(check);

  const img = document.createElement("img");
  img.src = favicon(entry.url);
  img.alt = "";
  row.appendChild(img);

  const info = document.createElement("span");
  info.className = "info";
  const title = document.createElement("a");
  title.className = "t";
  title.textContent = entry.title || entry.url;
  title.title = entry.url;
  title.addEventListener("click", () => restoreIds([entry.id]));
  const url = document.createElement("span");
  url.className = "u";
  url.textContent = entry.url;
  info.appendChild(title);
  info.appendChild(url);
  row.appendChild(info);

  if (entry.groupTitle) {
    const chip = document.createElement("span");
    chip.className = `chip gc-${entry.groupColor || "grey"}`;
    chip.textContent = entry.groupTitle;
    row.appendChild(chip);
  }

  const restore = document.createElement("button");
  restore.textContent = t("archiveRestore");
  restore.addEventListener("click", () => restoreIds([entry.id]));
  row.appendChild(restore);

  const del = document.createElement("button");
  del.className = "x";
  del.textContent = "×";
  del.title = t("archiveDelete");
  del.addEventListener("click", () => deleteIds([entry.id]));
  row.appendChild(del);

  return row;
}

function render() {
  const query = $("search").value.trim().toLowerCase();
  const visible = query
    ? entries.filter(
        (e) =>
          (e.title || "").toLowerCase().includes(query) ||
          (e.url || "").toLowerCase().includes(query) ||
          (e.domain || "").toLowerCase().includes(query),
      )
    : entries;

  const days = new Map();
  for (const entry of visible) {
    const day = localDateStr(entry.archivedAt);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(entry);
  }

  const container = $("days");
  container.textContent = "";
  for (const [day, list] of days) {
    const box = document.createElement("div");
    box.className = "day";
    const head = document.createElement("div");
    head.className = "dayhead";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = `${dayLabel(day)} - ${ttI18n.tabsCount(list.length)}`;
    head.appendChild(title);
    const restoreAll = document.createElement("button");
    restoreAll.textContent = t("archiveRestoreAll");
    restoreAll.addEventListener("click", () => restoreIds(list.map((e) => e.id)));
    head.appendChild(restoreAll);
    const deleteAll = document.createElement("button");
    deleteAll.textContent = t("archiveDeleteAll");
    deleteAll.addEventListener("click", () => deleteIds(list.map((e) => e.id)));
    head.appendChild(deleteAll);
    box.appendChild(head);
    for (const entry of list) box.appendChild(entryRow(entry));
    container.appendChild(box);
  }

  $("empty").hidden = visible.length > 0;
  renderSelbar();
}

function renderSelbar() {
  const bar = $("selbar");
  const live = [...selected].filter((id) => entries.some((e) => e.id === id));
  bar.hidden = live.length === 0;
  $("selCount").textContent = t("archiveSelected", [live.length]);
}

async function refresh() {
  const result = await send({ type: "ui:archive:list" });
  entries = result.entries || [];
  for (const id of [...selected]) {
    if (!entries.some((e) => e.id === id)) selected.delete(id);
  }
  render();
}

async function init() {
  const state = await send({ type: "ui:getState" });
  applyTheme(state.settings.theme);
  await ttI18n.init(state.settings.language);
  localizeDom();
  const ttl = state.settings.archiveTtl;
  const ttlLabel = { "7d": "optDays7", "30d": "optDays30", "90d": "optDays90" }[ttl];
  $("ttlNote").textContent = ttlLabel ? t("archiveTtlNote", [t(ttlLabel)]) : "";

  $("search").addEventListener("input", render);
  $("restoreSel").addEventListener("click", () => restoreIds([...selected]));
  $("deleteSel").addEventListener("click", () => deleteIds([...selected]));

  await refresh();
}

init();
