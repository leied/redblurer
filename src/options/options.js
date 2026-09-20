/**
 * options/options.js — the full settings page.
 *
 * Everything the popup deliberately leaves out: reveal behaviour, blur
 * strength, look-away rules, the domain list, detection, shortcuts and
 * backup.
 */
(function () {
  "use strict";

  const Config = globalThis.RedBlurerConfig;
  const Store = globalThis.RedBlurerStore;

  const el = {
    version: document.getElementById("version-badge"),
    lockBlur: document.getElementById("lockBlur"),
    keepRevealed: document.getElementById("keepRevealed"),
    keepRevealedItem: document.getElementById("keepRevealed-item"),
    blurRadius: document.getElementById("blurRadius"),
    blurRadiusDesc: document.getElementById("blurRadius-desc"),
    rehideOnBlur: document.getElementById("rehideOnBlur"),
    rehideAfterSeconds: document.getElementById("rehideAfterSeconds"),
    blurEverywhere: document.getElementById("blurEverywhere"),
    domains: document.getElementById("domains"),
    domainsField: document.getElementById("domains-field"),
    deepScan: document.getElementById("deepScan"),
    shortcutPanic: document.getElementById("shortcut-panic"),
    shortcutToggle: document.getElementById("shortcut-toggle"),
    editShortcuts: document.getElementById("edit-shortcuts"),
    exportBtn: document.getElementById("export"),
    importBtn: document.getElementById("import"),
    importFile: document.getElementById("import-file"),
    snackbar: document.getElementById("snackbar"),
  };

  const notify = Store.snackbar(el.snackbar);
  const store = Store.create({ onChange: render });

  function save(patch) {
    store.save(patch, (error) => {
      if (error) notify("Could not save that. " + error, true);
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function render() {
    const config = store.get();

    el.lockBlur.checked = config.lockBlur;
    el.keepRevealed.checked = config.keepRevealed;
    el.blurEverywhere.checked = config.blurEverywhere;
    el.rehideOnBlur.checked = config.rehideOnBlur;
    el.deepScan.checked = config.deepScan;
    el.blurRadius.value = String(config.blurRadius);

    renderRadius(config.blurRadius);
    renderRehideChoice(config.rehideAfterSeconds);

    // Keeping media revealed cannot do anything while hover is disabled, so
    // disable it rather than leaving a switch that has no effect.
    el.keepRevealed.disabled = config.lockBlur;
    el.keepRevealedItem.classList.toggle("is-disabled", config.lockBlur);

    el.domains.disabled = config.blurEverywhere;
    el.domainsField.classList.toggle("is-disabled", config.blurEverywhere);

    // Never overwrite something half typed.
    if (document.activeElement !== el.domains) {
      el.domains.value = Config.formatDomainList(config.domains);
    }
  }

  function renderRadius(value) {
    el.blurRadiusDesc.textContent = `${value} pixels`;
    el.blurRadius.setAttribute("aria-valuetext", `${value} pixels`);
    const min = Number(el.blurRadius.min);
    const max = Number(el.blurRadius.max);
    el.blurRadius.style.setProperty(
      "--slider-progress",
      `${((value - min) / (max - min)) * 100}%`,
    );
  }

  /**
   * The select only offers a few sensible delays. A stored value from
   * somewhere else might not be one of them, so add it rather than silently
   * showing the wrong option.
   */
  function renderRehideChoice(seconds) {
    const value = String(seconds);
    const known = [...el.rehideAfterSeconds.options].some((o) => o.value === value);
    if (!known) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `After ${seconds} seconds`;
      el.rehideAfterSeconds.appendChild(option);
    }
    el.rehideAfterSeconds.value = value;
  }

  // ── Bindings ──────────────────────────────────────────────────────────────

  for (const key of ["lockBlur", "keepRevealed", "blurEverywhere", "rehideOnBlur", "deepScan"]) {
    el[key].addEventListener("change", () => save({ [key]: el[key].checked }));
  }

  el.rehideAfterSeconds.addEventListener("change", () => {
    save({ rehideAfterSeconds: Config.clampRehideSeconds(el.rehideAfterSeconds.value) });
  });

  // Track the handle live, but only write once the drag settles.
  let radiusTimer = 0;
  el.blurRadius.addEventListener("input", () => {
    const value = Config.clampBlurRadius(el.blurRadius.value);
    renderRadius(value);
    clearTimeout(radiusTimer);
    radiusTimer = setTimeout(() => save({ blurRadius: value }), 150);
  });

  /** Clean up what was typed, store it, and show the result back. */
  el.domains.addEventListener("blur", () => {
    const typed = el.domains.value;
    const parsed = Config.parseDomainList(typed);
    const typedCount = typed.split(/[\s,;]+/).filter(Boolean).length;

    save({ domains: parsed });
    el.domains.value = Config.formatDomainList(parsed);

    const dropped = typedCount - parsed.length;
    if (dropped > 0) {
      notify(
        dropped === 1
          ? "Skipped 1 entry that is not a valid domain"
          : `Skipped ${dropped} entries that are not valid domains`,
        true,
      );
    }
  });

  // ── Shortcuts ─────────────────────────────────────────────────────────────

  function showShortcuts() {
    try {
      chrome.commands.getAll((commands) => {
        void chrome.runtime.lastError;
        const find = (name) => (commands || []).find((c) => c.name === name);
        const panic = find("panic");
        const toggle = find("toggle-blur");
        el.shortcutPanic.textContent = (panic && panic.shortcut) || "not set";
        el.shortcutToggle.textContent = (toggle && toggle.shortcut) || "not set";
      });
    } catch {
      /* commands API unavailable */
    }
  }

  el.editShortcuts.addEventListener("click", () => {
    // Extensions cannot change a binding themselves; they can only send you
    // to the browser's own page for it.
    const url = "chrome://extensions/shortcuts";
    try {
      chrome.tabs.create({ url });
    } catch {
      notify("Open your browser's extension shortcuts page to change these.", true);
    }
  });

  // ── Export and import ─────────────────────────────────────────────────────

  el.exportBtn.addEventListener("click", () => {
    const blob = new Blob([Config.serializeExport(store.get())], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "redblurer-config.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("Settings exported");
  });

  el.importBtn.addEventListener("click", () => el.importFile.click());

  el.importFile.addEventListener("change", () => {
    const file = el.importFile.files && el.importFile.files[0];
    el.importFile.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onerror = () => notify("Could not read that file", true);
    reader.onload = () => {
      const result = Config.parseImport(String(reader.result));
      if (!result.ok) {
        notify(result.error, true);
        return;
      }
      store.replace(result.config, (error) => {
        if (error) notify("Could not save that. " + error, true);
        else notify("Settings imported");
      });
    };
    reader.readAsText(file);
  });

  // ── Start ─────────────────────────────────────────────────────────────────

  try {
    el.version.textContent = "v" + chrome.runtime.getManifest().version;
  } catch {
    el.version.textContent = "";
  }

  showShortcuts();
  store.start();
})();
