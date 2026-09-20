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

// Chrome runs this as a service worker, where importScripts is how you pull in
// a dependency. Firefox runs it as an event page, which has no importScripts
// and instead lists shared/config.js alongside this file in its manifest.
if (typeof importScripts === "function") {
  importScripts("shared/config.js");
}

const Config = globalThis.RedBlurerConfig;

const BADGE_OFF_TEXT = "OFF";
const BADGE_LOCKED_TEXT = "HOLD";
const BADGE_COLOR = "#BA1A1A";

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
 * Reflect the current mode in the toolbar.
 *
 * The badge is the only signal you get without opening the popup, which
 * matters most right after a panic keypress: you need to know it landed.
 */
async function refreshBadge(config) {
  const cfg = Config.normalizeConfig(config || (await readAll()));

  let text = "";
  let title = "RedBlurer — blurring media";
  if (!cfg.enabled) {
    text = BADGE_OFF_TEXT;
    title = "RedBlurer — blurring is off";
  } else if (cfg.lockBlur) {
    text = BADGE_LOCKED_TEXT;
    title = "RedBlurer — holding everything blurred";
  }

  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await chrome.action.setTitle({ title });
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
  const relevant = ["enabled", "lockBlur"];
  if (!relevant.some((key) => Object.prototype.hasOwnProperty.call(changes, key))) return;
  refreshBadge();
});

// ── Keyboard shortcuts ──────────────────────────────────────────────────────
//
// The point of these is speed. Opening the popup and finding a switch takes
// several seconds; someone walking up behind you does not take several
// seconds. Everything here is a storage write, which every content script is
// already listening for, so no extra plumbing is needed.

/** Apply a change to the stored config and let the badge catch up. */
async function update(patch) {
  const config = Config.mergeConfig(await readAll(), patch);
  await write(config);
  await refreshBadge(config);
  return config;
}

const COMMANDS = {
  /**
   * Hide everything now, and again to let go. Locking also switches the
   * extension on, because a panic key that does nothing when you happen to
   * have blurring off is worse than no panic key at all.
   */
  async panic() {
    const current = Config.normalizeConfig(await readAll());
    const locking = !(current.enabled && current.lockBlur);
    return update(locking ? { enabled: true, lockBlur: true } : { lockBlur: false });
  },

  /** Plain on/off, for when you actually want to see the page. */
  async "toggle-blur"() {
    const current = Config.normalizeConfig(await readAll());
    return update({ enabled: !current.enabled });
  },
};

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    const handler = COMMANDS[command];
    if (handler) handler();
  });
}

// The worker can be spun up for reasons other than the events above; make
// sure the badge is right whenever it wakes.
refreshBadge();
