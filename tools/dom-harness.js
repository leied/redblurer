/**
 * tools/dom-harness.js — a browser-shaped environment for the tests.
 *
 * Loads the extension's real source files into a jsdom window with a stubbed
 * chrome API, so the content script and the popup can be exercised end to end
 * rather than only through their pure helpers.
 *
 * Lives outside test/ on purpose: Node's test runner treats everything under
 * that directory as a test file.
 */
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const SRC = path.join(__dirname, "..", "src");

const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

/**
 * A minimal chrome.storage.sync that behaves like the real one in the ways
 * the extension depends on: asynchronous callbacks, and onChanged firing for
 * every listener after a write.
 */
function createChromeStub(initial, options) {
  let store = { ...(initial || {}) };
  const changeListeners = [];
  const activeTab = (options && options.activeTabUrl) || "";
  const shortcuts = (options && options.shortcuts) || [
    { name: "panic", shortcut: "Alt+Shift+H" },
    { name: "toggle-blur", shortcut: "Alt+Shift+B" },
  ];

  const opened = { options: 0, tabs: [] };

  const api = {
    runtime: {
      lastError: undefined,
      getManifest: () => JSON.parse(readSrc("manifest.json")),
      openOptionsPage: () => {
        opened.options += 1;
      },
    },
    // The popup asks which tab it was opened over, and both surfaces ask
    // what the user's keyboard shortcuts currently are.
    tabs: {
      query(_query, callback) {
        setTimeout(() => callback(activeTab ? [{ id: 1, url: activeTab }] : [{ id: 1 }]), 0);
      },
      create(details) {
        opened.tabs.push(details.url);
      },
    },
    commands: {
      getAll(callback) {
        setTimeout(() => callback(shortcuts), 0);
      },
    },
    storage: {
      sync: {
        get(keys, callback) {
          // The real API is always asynchronous, and the extension has to
          // cope with the gap before settings arrive. Reproduce that.
          const snapshot = { ...store };
          setTimeout(() => {
            if (keys === null || keys === undefined) return callback(snapshot);
            const wanted = Array.isArray(keys) ? keys : [keys];
            const picked = {};
            for (const key of wanted) {
              if (key in snapshot) picked[key] = snapshot[key];
            }
            callback(picked);
          }, 0);
        },
        set(values, callback) {
          const changes = {};
          for (const [key, newValue] of Object.entries(values)) {
            changes[key] = { oldValue: store[key], newValue };
            store[key] = newValue;
          }
          if (callback) callback();
          for (const listener of [...changeListeners]) listener(changes, "sync");
        },
        remove(keys, callback) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
          if (callback) callback();
        },
      },
      onChanged: {
        addListener(fn) {
          changeListeners.push(fn);
        },
      },
    },
  };

  return {
    api,
    opened,
    read: () => ({ ...store }),
    /** Write as if another surface had changed a setting. */
    write: (values) => api.storage.sync.set(values, null),
  };
}

function makeWindow({ html, url, stored, chromeOptions }) {
  // jsdom cannot lay out or parse every modern CSS feature; its complaints
  // about that are not interesting here.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});

  const dom = new JSDOM(html, {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true, // gives us requestAnimationFrame
    virtualConsole,
  });

  const chrome = createChromeStub(stored, chromeOptions);
  dom.window.chrome = chrome.api;

  return { dom, window: dom.window, document: dom.window.document, chrome };
}

/** Wait for the extension's batched, frame-scheduled work to land. */
function settle(window, frames = 3) {
  return new Promise((resolve) => {
    let left = frames;
    const tick = () => {
      if (left-- <= 0) {
        setTimeout(resolve, 0);
        return;
      }
      window.requestAnimationFrame(tick);
    };
    tick();
  });
}

/**
 * A page with the content script running on it.
 *
 * @param {object} [options]
 * @param {string} [options.head] markup for <head>, e.g. a <style> block
 * @param {string} [options.body] markup for <body>
 * @param {string} [options.url] page URL, which decides domain scoping
 * @param {object} [options.stored] initial chrome.storage.sync contents
 */
async function loadContentScript(options = {}) {
  const url = options.url || "https://example.com/feed";
  const body = options.body || "";
  const head = options.head || "";
  const html = `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

  const env = makeWindow({ html, url, stored: options.stored });

  // Same order the manifest declares.
  env.window.eval(readSrc("shared/config.js"));
  env.window.eval(readSrc("shared/media.js"));
  env.window.eval(readSrc("content/content.js"));

  env.settle = (frames) => settle(env.window, frames);
  if (options.settle !== false) await env.settle();
  return env;
}

/**
 * One of the extension's own pages, wired up against a stubbed storage.
 * @param {"popup"|"options"} name
 */
async function loadExtensionPage(name, options = {}) {
  const html = readSrc(`${name}/${name}.html`);
  const env = makeWindow({
    html,
    url: `chrome-extension://redblurer/${name}/${name}.html`,
    stored: options.stored,
    chromeOptions: options,
  });

  // Downloads are not something jsdom can carry out.
  env.downloads = [];
  env.window.URL.createObjectURL = (blob) => {
    env.downloads.push(blob);
    return "blob:redblurer/1";
  };
  env.window.URL.revokeObjectURL = () => {};
  env.window.HTMLAnchorElement.prototype.click = function () {};

  // Same order the page's own script tags declare.
  env.window.eval(readSrc("shared/config.js"));
  env.window.eval(readSrc("ui/store.js"));
  env.window.eval(readSrc(`${name}/${name}.js`));

  env.settle = (frames) => settle(env.window, frames);
  await env.settle(1);
  return env;
}

/** The toolbar popup. */
const loadPopup = (options) => loadExtensionPage("popup", options);

/** The full settings page. */
const loadOptions = (options) => loadExtensionPage("options", options);

/** Fire a DOM event the way a browser would. */
function dispatch(el, type, init) {
  const window = el.ownerDocument.defaultView;
  el.dispatchEvent(new window.Event(type, { bubbles: true, ...init }));
}

module.exports = {
  loadContentScript,
  loadExtensionPage,
  loadOptions,
  loadPopup,
  dispatch,
  settle,
  readSrc,
  SRC,
};
