/**
 * The toolbar popup: the handful of controls you reach for in a hurry.
 */
const nodeTest = require("node:test");
const assert = require("node:assert/strict");

// The pure tests run with no dependencies at all. These need a DOM, so they
// step aside rather than fail when jsdom has not been installed.
const missing = (() => {
  try {
    require.resolve("jsdom");
    return null;
  } catch {
    return "needs jsdom: run npm install";
  }
})();
const test = missing ? (name) => nodeTest(name, { skip: missing }, () => {}) : nodeTest;

const { loadPopup, dispatch } = missing
  ? {}
  : require("../tools/dom-harness.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Values built inside jsdom carry that realm's prototypes; re-wrap to compare. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** The popup asks for the active tab asynchronously, so let that land. */
async function open(options) {
  const env = await loadPopup(options);
  await wait(20);
  return env;
}

// ── Rendering ───────────────────────────────────────────────────────────────

test("the popup shows the settings that are stored", async () => {
  const env = await open({ stored: { enabled: true, lockBlur: true } });
  assert.equal(env.document.getElementById("enabled").checked, true);
  assert.equal(env.document.getElementById("lockBlur").checked, true);
});

test("the version badge comes from the manifest, not a hardcoded string", async () => {
  const env = await open();
  const manifest = env.window.chrome.runtime.getManifest();
  assert.equal(env.document.getElementById("version-badge").textContent, "v" + manifest.version);
});

test("the headline says what is actually happening", async () => {
  const on = await open({ stored: { enabled: true } });
  assert.equal(on.document.getElementById("enabled-label").textContent, "Blur active");
  assert.equal(on.document.getElementById("hero").classList.contains("is-off"), false);

  const off = await open({ stored: { enabled: false } });
  assert.equal(off.document.getElementById("enabled-label").textContent, "Blur off");
  assert.ok(off.document.getElementById("hero").classList.contains("is-off"));
});

test("hold-everything is disabled while the extension is off", async () => {
  const env = await open({ stored: { enabled: false } });
  assert.equal(env.document.getElementById("lockBlur").disabled, true);
});

test("the popup stays small enough not to need scrolling", () => {
  // Chrome caps a popup at 600px and scrolls past it. The long-form settings
  // moved to the options page precisely so this one does not get there.
  const html = require("../tools/dom-harness.js").readSrc("popup/popup.html");
  assert.equal(/id="domains"/.test(html), false, "the domain list belongs on the options page");
  assert.equal(/id="blurRadius"/.test(html), false, "the slider belongs on the options page");
  assert.equal(/id="export"/.test(html), false, "backup belongs on the options page");
});

// ── The per-site switch ─────────────────────────────────────────────────────

test("the per-site switch names the site you are on", async () => {
  const env = await open({
    stored: { enabled: true, blurEverywhere: false, domains: [] },
    activeTabUrl: "https://news.ycombinator.com/",
  });
  assert.equal(
    env.document.getElementById("blurThisSite-label").textContent,
    "Blur news.ycombinator.com",
  );
});

test("the per-site switch is on when a parent domain already covers the host", async () => {
  // Listing reddit.com covers old.reddit.com, so the switch has to read as on
  // even though that exact host is not in the list.
  const env = await open({
    stored: { enabled: true, blurEverywhere: false, domains: ["reddit.com"] },
    activeTabUrl: "https://old.reddit.com/r/all",
  });
  assert.equal(env.document.getElementById("blurThisSite").checked, true);
});

test("turning the per-site switch on adds the host", async () => {
  const env = await open({
    stored: { enabled: true, blurEverywhere: false, domains: [] },
    activeTabUrl: "https://news.ycombinator.com/",
  });
  const toggle = env.document.getElementById("blurThisSite");

  toggle.checked = true;
  dispatch(toggle, "change");

  assert.deepEqual(plain(env.chrome.read().domains), ["news.ycombinator.com"]);
});

test("turning it off removes the parent entry that was covering the host", async () => {
  // Removing only the exact host would leave reddit.com listed, and the
  // switch would flip straight back on.
  const env = await open({
    stored: { enabled: true, blurEverywhere: false, domains: ["reddit.com", "x.com"] },
    activeTabUrl: "https://old.reddit.com/r/all",
  });
  const toggle = env.document.getElementById("blurThisSite");

  toggle.checked = false;
  dispatch(toggle, "change");

  assert.deepEqual(plain(env.chrome.read().domains), ["x.com"]);
});

test("the per-site switch explains itself while blurring everywhere", async () => {
  const env = await open({
    stored: { enabled: true, blurEverywhere: true },
    activeTabUrl: "https://example.com/",
  });
  assert.equal(env.document.getElementById("blurThisSite").disabled, true);
  assert.match(
    env.document.getElementById("blurThisSite-desc").textContent,
    /every site/i,
  );
});

test("the per-site switch stands down on a page it cannot act on", async () => {
  const env = await open({
    stored: { enabled: true, blurEverywhere: false },
    activeTabUrl: "chrome://extensions",
  });
  assert.equal(env.document.getElementById("blurThisSite").disabled, true);
  assert.match(
    env.document.getElementById("blurThisSite-desc").textContent,
    /not an ordinary web page/i,
  );
});

// ── Writing ─────────────────────────────────────────────────────────────────

test("flipping the main switch saves it", async () => {
  const env = await open({ stored: { enabled: true } });
  const toggle = env.document.getElementById("enabled");

  toggle.checked = false;
  dispatch(toggle, "change");

  assert.equal(env.chrome.read().enabled, false);
  assert.equal(env.document.getElementById("enabled-label").textContent, "Blur off");
});

test("hold-everything saves on its own without touching anything else", async () => {
  const env = await open({ stored: { enabled: true, blurEverywhere: true } });
  const lock = env.document.getElementById("lockBlur");

  lock.checked = true;
  dispatch(lock, "change");

  assert.equal(env.chrome.read().lockBlur, true);
  assert.equal(env.chrome.read().enabled, true);
  assert.equal(env.chrome.read().blurEverywhere, true);
});

test("a change made elsewhere shows up in the popup", async () => {
  const env = await open({ stored: { enabled: true } });
  env.chrome.write({ enabled: false });
  assert.equal(env.document.getElementById("enabled").checked, false);
});

// ── Getting to the rest ─────────────────────────────────────────────────────

test("the settings button opens the options page", async () => {
  const env = await open();
  dispatch(env.document.getElementById("open-options"), "click");
  assert.equal(env.chrome.opened.options, 1);
});

test("the popup shows the panic shortcut that is actually bound", async () => {
  const env = await open({ shortcuts: [{ name: "panic", shortcut: "Ctrl+Shift+9" }] });
  assert.equal(env.document.getElementById("shortcut-panic").textContent, "Ctrl+Shift+9");
});

test("the popup says so when no panic shortcut is bound", async () => {
  const env = await open({ shortcuts: [{ name: "panic", shortcut: "" }] });
  assert.match(env.document.getElementById("shortcut-panic").textContent, /no shortcut/i);
});
