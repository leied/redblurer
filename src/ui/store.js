/**
 * ui/store.js — shared settings plumbing for the popup and the options page.
 *
 * Both surfaces edit the same config, so both need the same four things:
 * read it, write a partial change, stay in step when the other one edits it,
 * and tell the user when something went wrong. Keeping that here means the
 * two cannot drift apart.
 *
 * Writes go straight to chrome.storage.sync. Content scripts are already
 * listening to onChanged, so there is no message to send.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
  if (root) root.RedBlurerStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const Config = globalThis.RedBlurerConfig;

  /**
   * @param {object} [options]
   * @param {(config: object) => void} options.onChange called whenever settings change
   * @returns {object} the store
   */
  function create(options) {
    const onChange = (options && options.onChange) || function () {};
    let config = Config.normalizeConfig(null);
    let lastError = null;

    /** The settings as they currently stand. Always complete and valid. */
    function get() {
      return config;
    }

    /** Read storage once, then keep up with it. */
    function start() {
      chrome.storage.sync.get(null, (stored) => {
        void chrome.runtime.lastError;
        config = Config.normalizeConfig(stored);
        onChange(config);
      });

      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") return;
        const next = { ...config };
        for (const [key, change] of Object.entries(changes)) next[key] = change.newValue;
        config = Config.normalizeConfig(next);
        onChange(config);
      });
    }

    /**
     * Apply a partial change. The local copy updates immediately so the UI
     * stays responsive, and storage catches up.
     *
     * @param {object} patch
     * @param {(error: string|null) => void} [done]
     */
    function save(patch, done) {
      config = Config.mergeConfig(config, patch);
      onChange(config);
      chrome.storage.sync.set(patch, () => {
        const err = chrome.runtime.lastError;
        lastError = err ? err.message : null;
        if (done) done(lastError);
      });
    }

    /**
     * Replace every setting at once, for an import.
     * @param {object} next
     * @param {(error: string|null) => void} [done]
     */
    function replace(next, done) {
      config = Config.normalizeConfig(next);
      onChange(config);
      chrome.storage.sync.set(config, () => {
        const err = chrome.runtime.lastError;
        if (done) done(err ? err.message : null);
      });
    }

    return { get, start, save, replace, lastError: () => lastError };
  }

  /**
   * Wire up a snackbar element and hand back a way to show messages.
   *
   * @param {Element} element the .snackbar node
   * @param {number} [duration]
   * @returns {(message: string, isError?: boolean) => void}
   */
  function snackbar(element, duration) {
    let timer = 0;
    const visibleFor = typeof duration === "number" ? duration : 4000;

    return function show(message, isError) {
      if (!element) return;
      element.textContent = message;
      element.classList.toggle("is-error", Boolean(isError));
      element.classList.add("is-open");
      clearTimeout(timer);
      timer = setTimeout(() => element.classList.remove("is-open"), visibleFor);
    };
  }

  /**
   * The hostname of the tab the popup was opened over.
   *
   * Returns "" for anything that is not an ordinary web page, so the caller
   * can say so rather than offering a switch that could not do anything.
   * No tabs permission is needed: <all_urls> host access already exposes the
   * URL of a matching tab.
   *
   * @param {(host: string) => void} callback
   */
  function activeHost(callback) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        void chrome.runtime.lastError;
        const url = tabs && tabs[0] ? tabs[0].url : "";
        let host = "";
        try {
          const parsed = new URL(url);
          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            host = parsed.hostname;
          }
        } catch {
          host = "";
        }
        callback(host);
      });
    } catch {
      callback("");
    }
  }

  return { create, snackbar, activeHost };
});
