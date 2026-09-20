/**
 * The options page: everything the popup deliberately leaves out.
 */
const nodeTest = require("node:test");
const assert = require("node:assert/strict");

const missing = (() => {
  try {
    require.resolve("jsdom");
    return null;
  } catch {
    return "needs jsdom: run npm install";
  }
})();
const test = missing ? (name) => nodeTest(name, { skip: missing }, () => {}) : nodeTest;

const { loadOptions, dispatch } = missing ? {} : require("../tools/dom-harness.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (value) => JSON.parse(JSON.stringify(value));

async function open(options) {
  const env = await loadOptions(options);
  await wait(20);
  return env;
}

function chooseFile(env, text) {
  const input = env.document.getElementById("import-file");
  const file = new env.window.File([text], "redblurer-config.json", {
    type: "application/json",
  });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  dispatch(input, "change");
}

// ── Rendering ───────────────────────────────────────────────────────────────

test("the page shows every stored setting", async () => {
  const env = await open({
    stored: {
      blurEverywhere: false,
      domains: ["x.com", "reddit.com"],
      keepRevealed: true,
      lockBlur: false,
      blurRadius: 30,
      rehideOnBlur: false,
      rehideAfterSeconds: 300,
      deepScan: false,
    },
  });
  const $ = (id) => env.document.getElementById(id);

  assert.equal($("blurEverywhere").checked, false);
  assert.equal($("keepRevealed").checked, true);
  assert.equal($("lockBlur").checked, false);
  assert.equal($("blurRadius").value, "30");
  assert.equal($("blurRadius-desc").textContent, "30 pixels");
  assert.equal($("rehideOnBlur").checked, false);
  assert.equal($("rehideAfterSeconds").value, "300");
  assert.equal($("deepScan").checked, false);
  assert.equal($("domains").value, "x.com\nreddit.com");
});

test("settings saved by the previous version still show up", async () => {
  const env = await open({
    stored: { blurEnabled: false, blockAll: false, blockedDomains: ["twitter.com"] },
  });
  assert.equal(env.document.getElementById("domains").value, "twitter.com");
  assert.equal(env.document.getElementById("blurEverywhere").checked, false);
});

test("a stored idle delay the menu does not list is added rather than lost", async () => {
  // Otherwise the menu would quietly show the wrong value and save it back.
  const env = await open({ stored: { rehideAfterSeconds: 47 } });
  const select = env.document.getElementById("rehideAfterSeconds");
  assert.equal(select.value, "47");
  assert.match([...select.options].find((o) => o.value === "47").textContent, /47 seconds/);
});

test("keep-unblurred is disabled while hover is switched off", async () => {
  const env = await open({ stored: { lockBlur: true } });
  assert.equal(env.document.getElementById("keepRevealed").disabled, true);
  assert.ok(env.document.getElementById("keepRevealed-item").classList.contains("is-disabled"));
});

test("the domain list is disabled while blurring everywhere", async () => {
  const env = await open({ stored: { blurEverywhere: true } });
  assert.equal(env.document.getElementById("domains").disabled, true);
  assert.ok(env.document.getElementById("domains-field").classList.contains("is-disabled"));
});

// ── Writing ─────────────────────────────────────────────────────────────────

test("each switch saves its own setting and nothing else", async () => {
  const env = await open({ stored: { blurEverywhere: true, deepScan: true } });
  const deepScan = env.document.getElementById("deepScan");

  deepScan.checked = false;
  dispatch(deepScan, "change");

  assert.equal(env.chrome.read().deepScan, false);
  assert.equal(env.chrome.read().blurEverywhere, true);
});

test("the look-away switches save", async () => {
  const env = await open({ stored: { rehideOnBlur: true } });
  const rehide = env.document.getElementById("rehideOnBlur");

  rehide.checked = false;
  dispatch(rehide, "change");

  assert.equal(env.chrome.read().rehideOnBlur, false);
});

test("choosing an idle delay saves it as a number", async () => {
  const env = await open({ stored: { rehideAfterSeconds: 60 } });
  const select = env.document.getElementById("rehideAfterSeconds");

  select.value = "300";
  dispatch(select, "change");

  assert.equal(env.chrome.read().rehideAfterSeconds, 300);
});

test("the slider reports as it moves and saves once it settles", async () => {
  const env = await open({ stored: { blurRadius: 18 } });
  const slider = env.document.getElementById("blurRadius");

  slider.value = "44";
  dispatch(slider, "input");

  assert.equal(env.document.getElementById("blurRadius-desc").textContent, "44 pixels");
  assert.equal(slider.getAttribute("aria-valuetext"), "44 pixels");
  assert.equal(env.chrome.read().blurRadius, 18, "should not save on every frame of a drag");

  await wait(250);
  assert.equal(env.chrome.read().blurRadius, 44);
});

test("the domain list is cleaned up when you leave the field", async () => {
  const env = await open({ stored: { blurEverywhere: false, domains: [] } });
  const domains = env.document.getElementById("domains");

  domains.value = "https://WWW.X.com/home\nreddit.com\nx.com\n";
  dispatch(domains, "blur");

  assert.deepEqual(plain(env.chrome.read().domains), ["x.com", "reddit.com"]);
  assert.equal(domains.value, "x.com\nreddit.com");
});

test("an entry that is not a domain is reported, not silently dropped", async () => {
  const env = await open({ stored: { blurEverywhere: false, domains: [] } });
  const domains = env.document.getElementById("domains");

  domains.value = "x.com\nthis is not a domain";
  dispatch(domains, "blur");

  const snackbar = env.document.getElementById("snackbar");
  assert.ok(snackbar.classList.contains("is-open"));
  assert.match(snackbar.textContent, /skipped/i);
  assert.deepEqual(plain(env.chrome.read().domains), ["x.com"]);
});

test("a change made elsewhere shows up on the page", async () => {
  const env = await open({ stored: { deepScan: true } });
  env.chrome.write({ deepScan: false });
  assert.equal(env.document.getElementById("deepScan").checked, false);
});

// ── Shortcuts ───────────────────────────────────────────────────────────────

test("the page lists the shortcuts that are actually bound", async () => {
  const env = await open({
    shortcuts: [
      { name: "panic", shortcut: "Ctrl+Shift+9" },
      { name: "toggle-blur", shortcut: "" },
    ],
  });
  assert.equal(env.document.getElementById("shortcut-panic").textContent, "Ctrl+Shift+9");
  assert.equal(env.document.getElementById("shortcut-toggle").textContent, "not set");
});

test("changing a shortcut hands off to the browser's own page", async () => {
  // An extension cannot rebind its own shortcuts; only the browser can.
  const env = await open();
  dispatch(env.document.getElementById("edit-shortcuts"), "click");
  assert.match(plain(env.chrome.opened.tabs)[0], /extensions\/shortcuts/);
});

// ── Backup ──────────────────────────────────────────────────────────────────

test("export writes the current settings as JSON", async () => {
  const env = await open({
    stored: { blurEverywhere: false, domains: ["x.com"], blurRadius: 24, deepScan: false },
  });
  dispatch(env.document.getElementById("export"), "click");

  assert.equal(env.downloads.length, 1);
  const payload = JSON.parse(await env.downloads[0].text());
  assert.equal(payload.app, "RedBlurer");
  assert.deepEqual(plain(payload.config.domains), ["x.com"]);
  assert.equal(payload.config.blurRadius, 24);
  assert.equal(payload.config.deepScan, false);
});

test("importing a file applies and saves it", async () => {
  const env = await open({ stored: { blurEverywhere: true } });
  chooseFile(
    env,
    JSON.stringify({
      app: "RedBlurer",
      version: 2,
      config: { blurEverywhere: false, domains: ["reddit.com"], blurRadius: 36 },
    }),
  );
  await wait(50);

  assert.deepEqual(plain(env.chrome.read().domains), ["reddit.com"]);
  assert.equal(env.document.getElementById("domains").value, "reddit.com");
  assert.match(env.document.getElementById("snackbar").textContent, /imported/i);
});

test("importing a config from the previous version works", async () => {
  const env = await open();
  chooseFile(env, JSON.stringify({ blurEnabled: false, blockedDomains: ["twitter.com"] }));
  await wait(50);

  assert.equal(env.chrome.read().enabled, false);
  assert.deepEqual(plain(env.chrome.read().domains), ["twitter.com"]);
});

test("a bad import explains itself and changes nothing", async () => {
  const env = await open({ stored: { blurRadius: 18 } });
  chooseFile(env, "this is not json at all");
  await wait(50);

  const snackbar = env.document.getElementById("snackbar");
  assert.ok(snackbar.classList.contains("is-error"));
  assert.match(snackbar.textContent, /valid JSON/i);
  assert.equal(env.chrome.read().blurRadius, 18);
});

test("a JSON file that is not a RedBlurer config is rejected", async () => {
  const env = await open({ stored: { blurRadius: 18 } });
  chooseFile(env, JSON.stringify({ someOtherApp: { theme: "dark" } }));
  await wait(50);

  assert.ok(env.document.getElementById("snackbar").classList.contains("is-error"));
  assert.equal(env.chrome.read().blurRadius, 18);
});
