/**
 * popup/popup.js — settings UI.
 *
 * Reads and writes chrome.storage.sync directly. Content scripts pick the
 * change up through chrome.storage.onChanged, so there is no message round
 * trip and no second copy of the state to drift out of sync.
 */
(function () {
  "use strict";

  const Config = globalThis.RedBlurerConfig;

  const el = {
    hero: document.getElementById("hero"),
    statusHeadline: document.getElementById("status-headline"),
    statusSupporting: document.getElementById("status-supporting"),
    version: document.getElementById("version-badge"),
    enabled: document.getElementById("enabled"),
    lockBlur: document.getElementById("lockBlur"),
    keepRevealed: document.getElementById("keepRevealed"),
    keepRevealedItem: document.getElementById("keepRevealed-item"),
    blurRadius: document.getElementById("blurRadius"),
    radiusValue: document.getElementById("radius-value"),
    blurEverywhere: document.getElementById("blurEverywhere"),
    domains: document.getElementById("domains"),
    domainsField: document.getElementById("domains-field"),
    exportBtn: document.getElementById("export"),
    importBtn: document.getElementById("import"),
    importFile: document.getElementById("import-file"),
    snackbar: document.getElementById("snackbar"),
  };

  let config = Config.normalizeConfig(null);
  let snackbarTimer = 0;

  // ── Storage ───────────────────────────────────────────────────────────────

  function load() {
    chrome.storage.sync.get(null, (stored) => {
      void chrome.runtime.lastError;
      config = Config.normalizeConfig(stored);
      render();
    });
  }

  /** Persist a partial change. Everything in the UI funnels through here. */
  function save(patch) {
    config = Config.mergeConfig(config, patch);
    chrome.storage.sync.set(patch, () => {
      const err = chrome.runtime.lastError;
      if (err) showSnackbar("Could not save. Storage may be full.", true);
    });
    render();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function render() {
    el.enabled.checked = config.enabled;
    el.lockBlur.checked = config.lockBlur;
    el.keepRevealed.checked = config.keepRevealed;
    el.blurEverywhere.checked = config.blurEverywhere;
    el.blurRadius.value = String(config.blurRadius);

    el.hero.classList.toggle("is-off", !config.enabled);
    el.statusHeadline.textContent = config.enabled ? "Blur active" : "Blur off";
    el.statusSupporting.textContent = config.enabled
      ? describeScope()
      : "Media is fully visible";

    renderRadius(config.blurRadius);

    // "Keep media unblurred" cannot do anything while the blur is locked, so
    // say so by disabling it rather than leaving a switch that does nothing.
    const keepDisabled = config.lockBlur || !config.enabled;
    el.keepRevealed.disabled = keepDisabled;
    el.keepRevealedItem.classList.toggle("is-disabled", keepDisabled);

    el.lockBlur.disabled = !config.enabled;
    el.blurRadius.disabled = !config.enabled;
    el.blurEverywhere.disabled = !config.enabled;

    // The domain list is only consulted when blur-everywhere is off.
    const domainsDisabled = config.blurEverywhere || !config.enabled;
    el.domainsField.classList.toggle("is-disabled", domainsDisabled);
    el.domains.disabled = domainsDisabled;

    // Never stomp what the user is mid-way through typing.
    if (document.activeElement !== el.domains) {
      el.domains.value = Config.formatDomainList(config.domains);
    }
  }

  function describeScope() {
    if (config.blurEverywhere) return "Images and videos are hidden everywhere";
    const n = config.domains.length;
    if (n === 0) return "No domains listed, so nothing is being blurred";
    return n === 1 ? "Hidden on 1 listed domain" : `Hidden on ${n} listed domains`;
  }

  function renderRadius(value) {
    el.radiusValue.textContent = `${value} pixels`;
    el.blurRadius.setAttribute("aria-valuetext", `${value} pixels`);
    const min = Number(el.blurRadius.min);
    const max = Number(el.blurRadius.max);
    const pct = ((value - min) / (max - min)) * 100;
    el.blurRadius.style.setProperty("--slider-progress", `${pct}%`);
  }

  // ── Snackbar ──────────────────────────────────────────────────────────────

  function showSnackbar(message, isError) {
    el.snackbar.textContent = message;
    el.snackbar.classList.toggle("is-error", Boolean(isError));
    el.snackbar.classList.add("is-open");
    clearTimeout(snackbarTimer);
    snackbarTimer = setTimeout(() => {
      el.snackbar.classList.remove("is-open");
    }, 4000);
  }

  // ── Bindings ──────────────────────────────────────────────────────────────

  el.enabled.addEventListener("change", () => save({ enabled: el.enabled.checked }));
  el.lockBlur.addEventListener("change", () => save({ lockBlur: el.lockBlur.checked }));
  el.keepRevealed.addEventListener("change", () =>
    save({ keepRevealed: el.keepRevealed.checked }),
  );
  el.blurEverywhere.addEventListener("change", () =>
    save({ blurEverywhere: el.blurEverywhere.checked }),
  );

  // Track the handle live, but only write once the drag settles.
  let radiusTimer = 0;
  el.blurRadius.addEventListener("input", () => {
    const value = Config.clampBlurRadius(el.blurRadius.value);
    renderRadius(value);
    clearTimeout(radiusTimer);
    radiusTimer = setTimeout(() => save({ blurRadius: value }), 150);
  });

  /**
   * Normalize what was typed, store it, and show it back cleaned up. Telling
   * the user an entry was dropped beats silently discarding it.
   */
  function commitDomains() {
    const typed = el.domains.value;
    const parsed = Config.parseDomainList(typed);
    const typedCount = typed.split(/[\s,;]+/).filter(Boolean).length;

    save({ domains: parsed });
    el.domains.value = Config.formatDomainList(parsed);

    const dropped = typedCount - parsed.length;
    if (dropped > 0) {
      showSnackbar(
        dropped === 1
          ? "Skipped 1 entry that is not a valid domain"
          : `Skipped ${dropped} entries that are not valid domains`,
        true,
      );
    }
  }

  el.domains.addEventListener("blur", commitDomains);

  // ── Export ────────────────────────────────────────────────────────────────

  el.exportBtn.addEventListener("click", () => {
    const blob = new Blob([Config.serializeExport(config)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "redblurer-config.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Give the download a tick to start before the blob is torn down.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showSnackbar("Settings exported");
  });

  // ── Import ────────────────────────────────────────────────────────────────

  el.importBtn.addEventListener("click", () => el.importFile.click());

  el.importFile.addEventListener("change", () => {
    const file = el.importFile.files && el.importFile.files[0];
    el.importFile.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onerror = () => showSnackbar("Could not read that file", true);
    reader.onload = () => {
      const result = Config.parseImport(String(reader.result));
      if (!result.ok) {
        showSnackbar(result.error, true);
        return;
      }
      config = result.config;
      chrome.storage.sync.set(config, () => {
        void chrome.runtime.lastError;
        render();
        showSnackbar("Settings imported");
      });
    };
    reader.readAsText(file);
  });

  // ── Stay in sync ──────────────────────────────────────────────────────────

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const next = { ...config };
    for (const [key, change] of Object.entries(changes)) next[key] = change.newValue;
    config = Config.normalizeConfig(next);
    render();
  });

  // ── Start ─────────────────────────────────────────────────────────────────

  try {
    el.version.textContent = "v" + chrome.runtime.getManifest().version;
  } catch {
    el.version.textContent = "";
  }

  load();
})();
