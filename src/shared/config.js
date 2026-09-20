/**
 * shared/config.js — RedBlurer's configuration model.
 *
 * This is the single source of truth for what a valid RedBlurer config looks
 * like, how a host is matched against the domain list, and how import/export
 * payloads are validated. Everything here is pure: no DOM, no chrome.* calls.
 * That keeps it loadable from every context the extension runs in, and
 * testable under plain Node.
 *
 *   background service worker : importScripts("shared/config.js")
 *   content script            : listed before content.js in the manifest
 *   popup                     : <script src="../shared/config.js">
 *   tests                     : require("../src/shared/config.js")
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
  if (root) root.RedBlurerConfig = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** Schema version written into exported files. */
  const CONFIG_VERSION = 2;

  const MIN_BLUR_RADIUS = 4;
  const MAX_BLUR_RADIUS = 60;
  const DEFAULT_BLUR_RADIUS = 18;

  /** Idle re-hide delay, in seconds. Zero means never. */
  const MIN_REHIDE_SECONDS = 0;
  const MAX_REHIDE_SECONDS = 3600;
  const DEFAULT_REHIDE_SECONDS = 60;

  /**
   * Defaults. A fresh install blurs everywhere, because a privacy tool that
   * does nothing until you configure it is a privacy tool that fails quietly.
   * The domain list only takes over once `blurEverywhere` is turned off.
   */
  const DEFAULTS = Object.freeze({
    enabled: true,
    blurEverywhere: true,
    domains: Object.freeze([]),
    keepRevealed: false,
    lockBlur: false,
    blurRadius: DEFAULT_BLUR_RADIUS,
    // Re-hide anything already revealed when you look away. Cheap insurance,
    // and it only ever affects media you had chosen to reveal.
    rehideOnBlur: true,
    rehideAfterSeconds: DEFAULT_REHIDE_SECONDS,
    // Detect background images applied by a stylesheet, not just inline.
    // Costs a scan of the page, so it is here as an escape hatch.
    deepScan: true,
  });

  const KEYS = Object.freeze(Object.keys(DEFAULTS));

  /**
   * v1 stored these under different names. Read them when the v2 key is
   * missing so existing installs keep their settings across the upgrade.
   */
  const LEGACY_KEYS = Object.freeze({
    enabled: "blurEnabled",
    blurEverywhere: "blockAll",
    domains: "blockedDomains",
    keepRevealed: "persistentUnblur",
    lockBlur: "noHoverUnblur",
  });

  // ── Primitives ────────────────────────────────────────────────────────────

  function toBool(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }

  function clampBlurRadius(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_BLUR_RADIUS;
    return Math.min(MAX_BLUR_RADIUS, Math.max(MIN_BLUR_RADIUS, Math.round(n)));
  }

  function clampRehideSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_REHIDE_SECONDS;
    return Math.min(MAX_REHIDE_SECONDS, Math.max(MIN_REHIDE_SECONDS, Math.round(n)));
  }

  // ── Domains ───────────────────────────────────────────────────────────────

  /**
   * Reduce whatever the user typed to a bare lowercase hostname.
   *
   * Accepts "https://www.Example.com/feed?x=1", "*.example.com", "example.com:443"
   * and returns "example.com" for all of them. Returns "" for anything that
   * isn't a plausible hostname, so callers can just filter falsy values.
   *
   * @param {unknown} input
   * @returns {string} normalized hostname, or "" if unusable
   */
  function normalizeDomain(input) {
    let text = String(input == null ? "" : input).trim().toLowerCase();
    if (!text) return "";

    // Strip a scheme and anything after the authority.
    text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    text = text.split(/[/?#]/, 1)[0];

    // Strip credentials and port.
    const at = text.lastIndexOf("@");
    if (at !== -1) text = text.slice(at + 1);
    text = text.replace(/:\d+$/, "");

    // A leading wildcard or dot is how people write "and subdomains"; that is
    // already what matching does, so drop it rather than reject the entry.
    text = text.replace(/^\*\./, "").replace(/^\.+/, "").replace(/\.+$/, "");

    // People copy hostnames straight out of the URL bar, so "www.example.com"
    // is common. Matching already covers subdomains, and widening the rule is
    // the safe direction for a privacy tool, so fold it down to the bare name.
    if (text.startsWith("www.") && text.slice(4).includes(".")) {
      text = text.slice(4);
    }

    if (!text || text.length > 253) return "";
    if (text === "localhost") return text;

    // Bare IPv4 is a legitimate host; everything else needs a dotted label form.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
      return text.split(".").every((o) => Number(o) <= 255) ? text : "";
    }
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(text)) return "";
    if (text.split(".").some((label) => !label || label.length > 63)) return "";
    if (/(^-)|(-$)|(\.-)|(-\.)/.test(text)) return "";

    return text;
  }

  /**
   * Parse the popup's textarea into a clean, de-duplicated domain list.
   * Splits on newlines, commas and whitespace so pasted lists just work.
   *
   * @param {unknown} text
   * @returns {string[]}
   */
  function parseDomainList(text) {
    const source = Array.isArray(text) ? text : String(text == null ? "" : text).split(/[\s,;]+/);
    const seen = new Set();
    const out = [];
    for (const entry of source) {
      const domain = normalizeDomain(entry);
      if (domain && !seen.has(domain)) {
        seen.add(domain);
        out.push(domain);
      }
    }
    return out;
  }

  /**
   * Render a domain list back into textarea content.
   * @param {unknown} list
   * @returns {string}
   */
  function formatDomainList(list) {
    return (Array.isArray(list) ? list : []).join("\n");
  }

  /**
   * True when `host` is `domain` itself or any subdomain of it.
   * Guards against the classic "notexample.com".endsWith("example.com") bug.
   *
   * @param {unknown} host
   * @param {unknown} domain
   * @returns {boolean}
   */
  function hostMatchesDomain(host, domain) {
    const h = String(host == null ? "" : host).trim().toLowerCase().replace(/\.+$/, "");
    const d = normalizeDomain(domain);
    if (!h || !d) return false;
    return h === d || h.endsWith("." + d);
  }

  /**
   * Does this hostname fall under the blur rules in `config`?
   * @param {unknown} host
   * @param {object} [config]
   * @returns {boolean}
   */
  function shouldBlurHost(host, config) {
    const cfg = normalizeConfig(config);
    if (!cfg.enabled) return false;
    if (cfg.blurEverywhere) return true;
    return cfg.domains.some((domain) => hostMatchesDomain(host, domain));
  }

  /**
   * Same question, asked with a full URL. Non-web schemes never blur.
   * @param {unknown} url
   * @param {object} [config]
   * @returns {boolean}
   */
  function shouldBlurUrl(url, config) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return shouldBlurHost(parsed.hostname, config);
  }

  /**
   * Add or remove a host from a domain list, for the popup's per-site switch.
   *
   * Removing has to drop every entry the host matches, not just an exact one.
   * With "reddit.com" listed, turning the switch off on old.reddit.com has to
   * remove the parent entry, or the switch would flip straight back on.
   *
   * @param {unknown} domains current list
   * @param {unknown} host hostname to add or remove
   * @param {boolean} shouldBlur desired state for this host
   * @returns {string[]} the new list
   */
  function setHostInDomains(domains, host, shouldBlur) {
    const list = parseDomainList(domains);
    const target = normalizeDomain(host);
    if (!target) return list;

    if (shouldBlur) {
      return list.some((d) => hostMatchesDomain(target, d)) ? list : list.concat(target);
    }
    return list.filter((d) => !hostMatchesDomain(target, d));
  }

  // ── Whole-config handling ─────────────────────────────────────────────────

  /**
   * Coerce arbitrary stored/imported data into a complete, valid config.
   * Unknown keys are dropped; missing keys fall back to v1 names, then
   * to defaults. Always returns a fresh object with every key present.
   *
   * @param {unknown} raw
   * @returns {{enabled:boolean, blurEverywhere:boolean, domains:string[],
   *            keepRevealed:boolean, lockBlur:boolean, blurRadius:number}}
   */
  function normalizeConfig(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const pick = (key) => {
      if (Object.prototype.hasOwnProperty.call(src, key)) return src[key];
      const legacy = LEGACY_KEYS[key];
      if (legacy && Object.prototype.hasOwnProperty.call(src, legacy)) return src[legacy];
      return undefined;
    };

    return {
      enabled: toBool(pick("enabled"), DEFAULTS.enabled),
      blurEverywhere: toBool(pick("blurEverywhere"), DEFAULTS.blurEverywhere),
      domains: parseDomainList(pick("domains") ?? []),
      keepRevealed: toBool(pick("keepRevealed"), DEFAULTS.keepRevealed),
      lockBlur: toBool(pick("lockBlur"), DEFAULTS.lockBlur),
      blurRadius: clampBlurRadius(
        pick("blurRadius") === undefined ? DEFAULTS.blurRadius : pick("blurRadius"),
      ),
      rehideOnBlur: toBool(pick("rehideOnBlur"), DEFAULTS.rehideOnBlur),
      rehideAfterSeconds: clampRehideSeconds(
        pick("rehideAfterSeconds") === undefined
          ? DEFAULTS.rehideAfterSeconds
          : pick("rehideAfterSeconds"),
      ),
      deepScan: toBool(pick("deepScan"), DEFAULTS.deepScan),
    };
  }

  /**
   * Apply a partial update on top of a config, normalizing the result.
   * @param {unknown} current
   * @param {unknown} patch
   * @returns {object}
   */
  function mergeConfig(current, patch) {
    const base = normalizeConfig(current);
    const delta = patch && typeof patch === "object" ? patch : {};
    const next = { ...base };
    for (const key of KEYS) {
      if (Object.prototype.hasOwnProperty.call(delta, key)) next[key] = delta[key];
    }
    return normalizeConfig(next);
  }

  /** True when two configs describe the same settings. */
  function configsEqual(a, b) {
    const x = normalizeConfig(a);
    const y = normalizeConfig(b);
    return KEYS.every((key) =>
      key === "domains"
        ? x.domains.length === y.domains.length &&
          x.domains.every((d, i) => d === y.domains[i])
        : x[key] === y[key],
    );
  }

  // ── Import / export ───────────────────────────────────────────────────────

  /**
   * Build the object written to redblurer-config.json.
   * @param {unknown} config
   * @param {string} [exportedAt] ISO timestamp, injectable for tests
   * @returns {object}
   */
  function buildExport(config, exportedAt) {
    return {
      app: "RedBlurer",
      version: CONFIG_VERSION,
      exportedAt: exportedAt || new Date().toISOString(),
      config: normalizeConfig(config),
    };
  }

  /** Pretty JSON for the download blob. */
  function serializeExport(config, exportedAt) {
    return JSON.stringify(buildExport(config, exportedAt), null, 2) + "\n";
  }

  /**
   * Validate an imported file. Accepts both the v2 envelope and a bare v1
   * settings object, so configs exported by the old build still import.
   *
   * @param {unknown} input JSON text or an already-parsed object
   * @returns {{ok:true, config:object} | {ok:false, error:string}}
   */
  function parseImport(input) {
    let data = input;

    if (typeof data === "string") {
      if (!data.trim()) return { ok: false, error: "The file is empty." };
      try {
        data = JSON.parse(data);
      } catch {
        return { ok: false, error: "That file isn't valid JSON." };
      }
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "That file doesn't contain a RedBlurer config." };
    }

    const body =
      data.config && typeof data.config === "object" && !Array.isArray(data.config)
        ? data.config
        : data;

    const known = KEYS.concat(Object.values(LEGACY_KEYS));
    if (!known.some((key) => Object.prototype.hasOwnProperty.call(body, key))) {
      return { ok: false, error: "That file doesn't contain any RedBlurer settings." };
    }

    return { ok: true, config: normalizeConfig(body) };
  }

  return {
    CONFIG_VERSION,
    DEFAULTS,
    KEYS,
    LEGACY_KEYS,
    MIN_BLUR_RADIUS,
    MAX_BLUR_RADIUS,
    DEFAULT_BLUR_RADIUS,
    MIN_REHIDE_SECONDS,
    MAX_REHIDE_SECONDS,
    DEFAULT_REHIDE_SECONDS,
    clampBlurRadius,
    clampRehideSeconds,
    setHostInDomains,
    normalizeDomain,
    parseDomainList,
    formatDomainList,
    hostMatchesDomain,
    shouldBlurHost,
    shouldBlurUrl,
    normalizeConfig,
    mergeConfig,
    configsEqual,
    buildExport,
    serializeExport,
    parseImport,
  };
});
