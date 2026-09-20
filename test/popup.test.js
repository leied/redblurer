/**
 * The popup, exercised against a real DOM and a stubbed chrome.storage.
 */
const nodeTest = require("node:test");

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
const assert = require("node:assert/strict");
const { loadPopup, dispatch } = missing
  ? {}
  : require("../tools/dom-harness.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Values built inside the jsdom window carry that realm's prototypes, which
 * strict deep-equality treats as a difference. Re-wrap before comparing.
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Hand the file input a file and tell the popup about it. */
function chooseFile(env, text, name = "redblurer-config.json") {
  const input = env.document.getElementById("import-file");
  const file = new env.window.File([text], name, { type: "application/json" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  dispatch(input, "change");
}

// ── Rendering ───────────────────────────────────────────────────────────────

test("the popup shows the settings that are stored", async () => {
  const env = await loadPopup({
    stored: {
      enabled: true,
      blurEverywhere: false,
      domains: ["x.com", "reddit.com"],
      keepRevealed: true,
      lockBlur: false,
      blurRadius: 30,
    },
  });
  const $ = (id) => env.document.getElementById(id);

  assert.equal($("enabled").checked, true);
  assert.equal($("blurEverywhere").checked, false);
  assert.equal($("keepRevealed").checked, true);
  assert.equal($("lockBlur").checked, false);
  assert.equal($("blurRadius").value, "30");
  assert.equal($("domains").value, "x.com\nreddit.com");
  assert.equal($("radius-value").textContent, "30 pixels");
});

test("the popup shows settings saved by the previous version", async () => {
  const env = await loadPopup({
    stored: { blurEnabled: false, blockAll: false, blockedDomains: ["twitter.com"] },
  });
  assert.equal(env.document.getElementById("enabled").checked, false);
  assert.equal(env.document.getElementById("domains").value, "twitter.com");
});

test("the version badge comes from the manifest, not a hardcoded string", async () => {
  const env = await loadPopup();
  const manifest = env.window.chrome.runtime.getManifest();
  assert.equal(env.document.getElementById("version-badge").textContent, "v" + manifest.version);
});

test("the headline says what is actually happening", async () => {
  const on = await loadPopup({ stored: { enabled: true, blurEverywhere: true } });
  assert.equal(on.document.getElementById("status-headline").textContent, "Blur active");
  assert.equal(on.document.getElementById("hero").classList.contains("is-off"), false);

  const off = await loadPopup({ stored: { enabled: false } });
  assert.equal(off.document.getElementById("status-headline").textContent, "Blur off");
  assert.ok(off.document.getElementById("hero").classList.contains("is-off"));
});

test("the popup admits when a domain list would blur nothing", async () => {
  const env = await loadPopup({
    stored: { enabled: true, blurEverywhere: false, domains: [] },
  });
  assert.match(
    env.document.getElementById("status-supporting").textContent,
    /nothing is being blurred/i,
  );
});

test("the popup counts the domains it will act on", async () => {
  const one = await loadPopup({
    stored: { enabled: true, blurEverywhere: false, domains: ["x.com"] },
  });
  assert.match(one.document.getElementById("status-supporting").textContent, /1 listed domain\b/);

  const many = await loadPopup({
    stored: { enabled: true, blurEverywhere: false, domains: ["x.com", "reddit.com"] },
  });
  assert.match(many.document.getElementById("status-supporting").textContent, /2 listed domains/);
});

// ── Controls that cannot do anything are disabled ───────────────────────────

test("keep-unblurred is disabled while the blur is locked", async () => {
  const env = await loadPopup({ stored: { enabled: true, lockBlur: true } });
  assert.equal(env.document.getElementById("keepRevealed").disabled, true);
  assert.ok(env.document.getElementById("keepRevealed-item").classList.contains("is-disabled"));
});

test("the domain list is disabled while blurring everywhere", async () => {
  const env = await loadPopup({ stored: { enabled: true, blurEverywhere: true } });
  assert.equal(env.document.getElementById("domains").disabled, true);
  assert.ok(env.document.getElementById("domains-field").classList.contains("is-disabled"));
});

test("turning the extension off disables the settings below it", async () => {
  const env = await loadPopup({ stored: { enabled: false } });
  for (const id of ["lockBlur", "keepRevealed", "blurEverywhere", "blurRadius", "domains"]) {
    assert.equal(env.document.getElementById(id).disabled, true, `#${id} should be disabled`);
  }
});

// ── Writing ─────────────────────────────────────────────────────────────────

test("flipping a switch saves it", async () => {
  const env = await loadPopup({ stored: { enabled: true } });
  const toggle = env.document.getElementById("enabled");

  toggle.checked = false;
  dispatch(toggle, "change");

  assert.equal(env.chrome.read().enabled, false);
  assert.equal(env.document.getElementById("status-headline").textContent, "Blur off");
});

test("each switch saves its own setting and nothing else", async () => {
  const env = await loadPopup({ stored: { enabled: true, blurEverywhere: true } });
  const lock = env.document.getElementById("lockBlur");

  lock.checked = true;
  dispatch(lock, "change");

  assert.equal(env.chrome.read().lockBlur, true);
  assert.equal(env.chrome.read().enabled, true, "unrelated settings should be untouched");
  assert.equal(env.chrome.read().blurEverywhere, true);
});

test("the slider reports as it moves and saves once it settles", async () => {
  const env = await loadPopup({ stored: { blurRadius: 18 } });
  const slider = env.document.getElementById("blurRadius");

  slider.value = "44";
  dispatch(slider, "input");

  assert.equal(env.document.getElementById("radius-value").textContent, "44 pixels");
  assert.equal(slider.getAttribute("aria-valuetext"), "44 pixels");
  assert.equal(env.chrome.read().blurRadius, 18, "should not save on every frame of a drag");

  await wait(250);
  assert.equal(env.chrome.read().blurRadius, 44);
});

test("the domain list is cleaned up when you leave the field", async () => {
  const env = await loadPopup({ stored: { blurEverywhere: false, domains: [] } });
  const domains = env.document.getElementById("domains");

  domains.value = "https://WWW.X.com/home\nreddit.com\nx.com\n";
  dispatch(domains, "blur");

  assert.deepEqual(plain(env.chrome.read().domains), ["x.com", "reddit.com"]);
  assert.equal(domains.value, "x.com\nreddit.com", "the field should show what was stored");
});

test("an entry that is not a domain is reported, not silently dropped", async () => {
  const env = await loadPopup({ stored: { blurEverywhere: false, domains: [] } });
  const domains = env.document.getElementById("domains");

  domains.value = "x.com\nthis is not a domain";
  dispatch(domains, "blur");

  const snackbar = env.document.getElementById("snackbar");
  assert.ok(snackbar.classList.contains("is-open"));
  assert.match(snackbar.textContent, /skipped/i);
  assert.deepEqual(plain(env.chrome.read().domains), ["x.com"]);
});

test("a change made elsewhere shows up in the popup", async () => {
  const env = await loadPopup({ stored: { enabled: true } });
  env.chrome.write({ enabled: false });
  assert.equal(env.document.getElementById("enabled").checked, false);
});

// ── Export and import ───────────────────────────────────────────────────────

test("export writes the current settings as JSON", async () => {
  const env = await loadPopup({
    stored: { enabled: false, blurEverywhere: false, domains: ["x.com"], blurRadius: 24 },
  });
  dispatch(env.document.getElementById("export"), "click");

  assert.equal(env.downloads.length, 1);
  const payload = JSON.parse(await env.downloads[0].text());
  assert.equal(payload.app, "RedBlurer");
  assert.equal(payload.config.enabled, false);
  assert.deepEqual(plain(payload.config.domains), ["x.com"]);
  assert.equal(payload.config.blurRadius, 24);
});

test("importing a file applies and saves it", async () => {
  const env = await loadPopup({ stored: { enabled: true, blurEverywhere: true } });
  chooseFile(
    env,
    JSON.stringify({
      app: "RedBlurer",
      version: 2,
      config: { enabled: false, blurEverywhere: false, domains: ["reddit.com"], blurRadius: 36 },
    }),
  );
  await wait(50);

  assert.equal(env.chrome.read().enabled, false);
  assert.deepEqual(plain(env.chrome.read().domains), ["reddit.com"]);
  assert.equal(env.document.getElementById("enabled").checked, false);
  assert.equal(env.document.getElementById("domains").value, "reddit.com");
  assert.match(env.document.getElementById("snackbar").textContent, /imported/i);
});

test("importing a config from the previous version works", async () => {
  const env = await loadPopup({ stored: { enabled: true } });
  chooseFile(env, JSON.stringify({ blurEnabled: false, blockedDomains: ["twitter.com"] }));
  await wait(50);

  assert.equal(env.chrome.read().enabled, false);
  assert.deepEqual(plain(env.chrome.read().domains), ["twitter.com"]);
});

test("a bad import explains itself and changes nothing", async () => {
  // The previous build caught the parse error and did nothing at all, so a
  // mistyped file looked exactly like a successful import.
  const env = await loadPopup({ stored: { enabled: true, blurRadius: 18 } });
  chooseFile(env, "this is not json at all");
  await wait(50);

  const snackbar = env.document.getElementById("snackbar");
  assert.ok(snackbar.classList.contains("is-open"));
  assert.ok(snackbar.classList.contains("is-error"));
  assert.match(snackbar.textContent, /valid JSON/i);
  assert.equal(env.chrome.read().enabled, true, "settings should be left alone");
  assert.equal(env.document.getElementById("enabled").checked, true);
});

test("a JSON file that is not a RedBlurer config is rejected", async () => {
  const env = await loadPopup({ stored: { enabled: true } });
  chooseFile(env, JSON.stringify({ someOtherApp: { theme: "dark" } }));
  await wait(50);

  const snackbar = env.document.getElementById("snackbar");
  assert.ok(snackbar.classList.contains("is-error"));
  assert.equal(env.chrome.read().enabled, true);
});
