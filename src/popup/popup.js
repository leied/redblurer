/**
 * popup/popup.js — the controls you reach for in a hurry.
 *
 * Deliberately narrow: the global switch, a hold-everything switch, and a
 * per-site switch for the tab you are looking at. Everything else lives on
 * the options page.
 */
(function () {
  "use strict";

  const Config = globalThis.RedBlurerConfig;
  const Store = globalThis.RedBlurerStore;

  const el = {
    hero: document.getElementById("hero"),
    headline: document.getElementById("enabled-label"),
    supporting: document.getElementById("enabled-desc"),
    version: document.getElementById("version-badge"),
    enabled: document.getElementById("enabled"),
    lockBlur: document.getElementById("lockBlur"),
    blurThisSite: document.getElementById("blurThisSite"),
    blurThisSiteItem: document.getElementById("blurThisSite-item"),
    blurThisSiteLabel: document.getElementById("blurThisSite-label"),
    blurThisSiteDesc: document.getElementById("blurThisSite-desc"),
    openOptions: document.getElementById("open-options"),
    shortcutPanic: document.getElementById("shortcut-panic"),
    snackbar: document.getElementById("snackbar"),
  };

  const notify = Store.snackbar(el.snackbar);

  /** Hostname of the tab underneath, or "" when it is not a web page. */
  let host = "";
  let hostKnown = false;

  const store = Store.create({ onChange: render });

  /** Save, and speak up if storage refused. */
  function save(patch) {
    store.save(patch, (error) => {
      if (error) notify("Could not save that. " + error, true);
    });
  }

  function render() {
    const config = store.get();

    el.enabled.checked = config.enabled;
    el.lockBlur.checked = config.lockBlur;
    el.lockBlur.disabled = !config.enabled;

    el.hero.classList.toggle("is-off", !config.enabled);
    el.headline.textContent = config.enabled ? "Blur active" : "Blur off";
    el.supporting.textContent = config.enabled
      ? "Images and videos are hidden"
      : "Media is fully visible";

    renderSite(config);
  }

  /**
   * The per-site switch. It reflects whether the current host would actually
   * be blurred, which is not the same as whether it appears in the list: a
   * parent domain can cover it.
   */
  function renderSite(config) {
    if (!hostKnown) {
      el.blurThisSite.disabled = true;
      el.blurThisSiteDesc.textContent = "Checking the current tab…";
      return;
    }

    if (!host) {
      el.blurThisSite.checked = false;
      el.blurThisSite.disabled = true;
      el.blurThisSiteItem.classList.add("is-disabled");
      el.blurThisSiteLabel.textContent = "Blur this site";
      el.blurThisSiteDesc.textContent = "This tab is not an ordinary web page";
      return;
    }

    el.blurThisSiteLabel.textContent = "Blur " + host;

    if (config.blurEverywhere) {
      // The switch would have nothing to act on, so say why rather than
      // offering a control that silently does nothing.
      el.blurThisSite.checked = true;
      el.blurThisSite.disabled = true;
      el.blurThisSiteItem.classList.add("is-disabled");
      el.blurThisSiteDesc.textContent = "Blurring on every site is on";
      return;
    }

    const covered = Config.shouldBlurHost(host, { ...config, enabled: true });
    el.blurThisSite.checked = covered;
    el.blurThisSite.disabled = !config.enabled;
    el.blurThisSiteItem.classList.toggle("is-disabled", !config.enabled);
    el.blurThisSiteDesc.textContent = covered
      ? "On your domain list"
      : "Not on your domain list";
  }

  // ── Bindings ──────────────────────────────────────────────────────────────

  el.enabled.addEventListener("change", () => {
    save({ enabled: el.enabled.checked });
  });

  el.lockBlur.addEventListener("change", () => {
    save({ lockBlur: el.lockBlur.checked });
  });

  el.blurThisSite.addEventListener("change", () => {
    if (!host) return;
    const domains = Config.setHostInDomains(
      store.get().domains,
      host,
      el.blurThisSite.checked,
    );
    save({ domains });
  });

  el.openOptions.addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
      window.close();
    }
  });

  // ── Start ─────────────────────────────────────────────────────────────────

  try {
    el.version.textContent = "v" + chrome.runtime.getManifest().version;
  } catch {
    el.version.textContent = "";
  }

  // Show the shortcut the user actually has bound, which may not be ours.
  try {
    chrome.commands.getAll((commands) => {
      void chrome.runtime.lastError;
      const panic = (commands || []).find((c) => c.name === "panic");
      if (panic && panic.shortcut) el.shortcutPanic.textContent = panic.shortcut;
      else el.shortcutPanic.textContent = "No shortcut set";
    });
  } catch {
    /* commands API unavailable */
  }

  Store.activeHost((found) => {
    host = found;
    hostKnown = true;
    render();
  });

  store.start();
})();
