/**
 * background.js — RedBlurer service worker.
 *
 * Deliberately small. The popup writes settings straight to chrome.storage
 * and content scripts react to chrome.storage.onChanged, so there is no
 * message-passing layer to keep in sync. That removes the whole class of bug
 * where one surface updates and another quietly does not.
 *
 * What is left genuinely needs a background context:
 *   • seeding defaults on first install
 *   • migrating v1 setting names on upgrade
 *   • keeping the toolbar badge honest about whether blurring is on
 */
"use strict";

importScripts("shared/config.js");

const Config = globalThis.RedBlurerConfig;

const BADGE_OFF_TEXT = "OFF";
const BADGE_OFF_COLOR = "#BA1A1A";

/** Promise wrappers, so the logic below reads top to bottom. */
function readAll() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(null, (stored) => {
      void chrome.runtime.lastError;
      resolve(stored || {});
    });
  });
}

function write(values) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(values, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function removeKeys(keys) {
  if (!keys.length) return Promise.resolve();
  return new Promise((resolve) => {
    chrome.storage.sync.remove(keys, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

/**
 * Reflect the global on/off switch in the toolbar.
 * A badge is the only signal the user gets that blurring is off without
 * opening the popup, which matters when the whole point is not being caught out.
 */
async function refreshBadge(config) {
  const cfg = Config.normalizeConfig(config || (await readAll()));
  try {
    await chrome.action.setBadgeText({ text: cfg.enabled ? "" : BADGE_OFF_TEXT });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_OFF_COLOR });
    await chrome.action.setTitle({
      title: cfg.enabled ? "RedBlurer — blurring media" : "RedBlurer — blurring is off",
    });
  } catch {
    /* action API unavailable during teardown */
  }
}

/**
 * Write a complete, normalized config back to storage and drop any v1 keys.
 * Running this on every install and update means storage only ever holds one
 * shape, so nothing downstream has to know v1 existed.
 */
async function reconcile(stored) {
  const config = Config.normalizeConfig(stored);
  await write(config);

  const stale = Object.values(Config.LEGACY_KEYS).filter((key) =>
    Object.prototype.hasOwnProperty.call(stored, key),
  );
  await removeKeys(stale);
  return config;
}

chrome.runtime.onInstalled.addListener((details) => {
  (async () => {
    const stored = await readAll();

    if (details.reason === "install") {
      // Nothing to preserve; write the defaults verbatim.
      const config = Config.normalizeConfig(null);
      await write(config);
      await refreshBadge(config);
      return;
    }

    // On update, keep whatever the user had. The previous build reset every
    // setting here, because it never checked why the event fired.
    const config = await reconcile(stored);
    await refreshBadge(config);
  })();
});

chrome.runtime.onStartup.addListener(() => {
  refreshBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (!Object.prototype.hasOwnProperty.call(changes, "enabled")) return;
  refreshBadge();
});

// The worker can be spun up for reasons other than the events above; make
// sure the badge is right whenever it wakes.
refreshBadge();
