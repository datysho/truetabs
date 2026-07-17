// TrueTabs - the settings schema, shared VERBATIM by the service worker
// (importScripts) and by the pages (script tag). One source of truth for
// defaults and validation lets a page paint REAL control values straight
// from storage on its first frame - no waiting for the engine, no flicker
// of default states, and an update can never poison a read: every stored
// value is validated on the way in, retired keys map to their successors.
const ttSchema = (() => {
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
    // Sort modes are MAINTAINED invariants: new tabs slot into place, manual
    // drags snap back, "recent" surfaces what you use - instantly.
    sortGroups: "off", // "off" | "title" | "recent" | "opened" - group order
    sortTabs: "off", // same values - tab order (loose + inside our groups)
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

  const SETTING_ENUMS = {
    dedupScope: ["window", "all"],
    archiveAfter: ["6h", "12h", "24h", "3d", "7d", "off"],
    archiveTtl: ["7d", "30d", "90d", "forever"],
    autoGroup: ["off", "site", "topic"],
    groupCollapseAfter: ["off", "5m", "10m", "30m"],
    sortGroups: ["off", "title", "recent", "opened"],
    sortTabs: ["off", "title", "recent", "opened"],
    smartEngine: ["off", "builtin", "byok"],
    byokProvider: ["openai", "gemini", "grok", "custom"],
    theme: ["auto", "light", "dark"],
    iconStyle: ["color", "mono"],
  };

  const GROUP_COLORS = [
    "grey",
    "blue",
    "red",
    "yellow",
    "green",
    "pink",
    "purple",
    "cyan",
    "orange",
  ];

  function fnv1a32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  const colorFor = (name) => GROUP_COLORS[fnv1a32(name) % GROUP_COLORS.length];

  function normalizeSettings(raw) {
    const src = raw && typeof raw === "object" ? { ...raw } : {};
    // v1.3 -> v1.4 renames (idempotent: old keys apply only while new ones are absent).
    if (!("autoGroup" in src)) {
      if (src.groupAuto === false) src.autoGroup = "off";
      else if (src.smartAutoAssign === true && src.smartEngine && src.smartEngine !== "off") {
        src.autoGroup = "topic";
      }
    }
    if (!("sortTabs" in src) && typeof src.sortMode === "string") src.sortTabs = src.sortMode;
    if (!("sortGroups" in src) && typeof src.sortMode === "string") src.sortGroups = src.sortMode;
    // v1.5 -> v1.7: the separate "live" mode merged into "recent" - every
    // sort is maintained live now, recency just adds surfacing-on-use.
    if (src.sortTabs === "live") src.sortTabs = "recent";
    if (src.sortGroups === "live") src.sortGroups = "recent";
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

  // Custom rule groups: the user's own named groups with routing rules.
  // Stored under their own sync key with hard caps - sync gives one item
  // ~8KB and rules must never be the thing that breaks saving settings.
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
        .map((d) =>
          d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""),
        )
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

  return { DEFAULTS, GROUP_COLORS, fnv1a32, colorFor, normalizeSettings, normalizeCustomGroups };
})();
