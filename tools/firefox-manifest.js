/**
 * tools/firefox-manifest.js — turn the Chrome manifest into a Firefox one.
 *
 * Firefox supports Manifest V3, but not identically. Everything that differs
 * is handled here as a pure transform so the differences are in one readable
 * place and can be tested without running a browser.
 *
 * The extension's own code is shared verbatim; only the manifest changes.
 * Firefox provides the `chrome.*` namespace with callbacks alongside its own
 * promise-based `browser.*`, so nothing in src/ needs a second code path.
 */
"use strict";

/** Identifies the add-on to Firefox. Required for storage.sync and signing. */
const GECKO_ID = "redblurer@lzccr.github.io";

/** Firefox 115 is the oldest ESR with Manifest V3 on by default. */
const MIN_FIREFOX = "115.0";

/**
 * Chrome-only manifest keys. Firefox warns about keys it does not know, and
 * a warning on every install looks like a broken add-on.
 */
const CHROME_ONLY_CONTENT_SCRIPT_KEYS = ["match_origin_as_fallback"];

/**
 * @param {object} chromeManifest the parsed src/manifest.json
 * @returns {object} a manifest Firefox will accept
 */
function toFirefoxManifest(chromeManifest) {
  const manifest = JSON.parse(JSON.stringify(chromeManifest));

  // Firefox runs the background as an event page and has no importScripts,
  // so the dependency the service worker pulls in is listed explicitly.
  if (manifest.background && manifest.background.service_worker) {
    manifest.background = {
      scripts: ["shared/config.js", manifest.background.service_worker],
    };
  }

  manifest.browser_specific_settings = {
    gecko: { id: GECKO_ID, strict_min_version: MIN_FIREFOX },
  };

  manifest.content_scripts = (manifest.content_scripts || []).map((script) => {
    const copy = { ...script };
    for (const key of CHROME_ONLY_CONTENT_SCRIPT_KEYS) delete copy[key];
    return copy;
  });

  return manifest;
}

module.exports = {
  GECKO_ID,
  MIN_FIREFOX,
  CHROME_ONLY_CONTENT_SCRIPT_KEYS,
  toFirefoxManifest,
};
