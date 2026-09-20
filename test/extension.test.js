/**
 * Packaging and wiring checks.
 *
 * A Chrome extension fails hard and silently on these: a mistyped path in the
 * manifest, a script that never loads, a getElementById that finds nothing.
 * None of it shows up in a unit test of the logic, so it gets checked here.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.join(__dirname, "..", "src");
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(SRC, rel));

/** Every file under src, relative to src. */
function walk(dir = SRC, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel];
  });
}

test("the manifest is Manifest V3", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test("the manifest version matches the package version", () => {
  assert.equal(manifest.version, pkg.version);
});

test("every file the manifest points at exists", () => {
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
  ];
  for (const rel of referenced) {
    assert.ok(exists(rel), `missing file referenced by manifest: ${rel}`);
  }
});

test("the content script loads its dependencies first", () => {
  // shared/config.js and shared/media.js define the globals content.js reads
  // at module scope. Out of order, the content script silently does nothing.
  const js = manifest.content_scripts[0].js;
  assert.ok(js.indexOf("shared/config.js") < js.indexOf("content/content.js"));
  assert.ok(js.indexOf("shared/media.js") < js.indexOf("content/content.js"));
});

test("the content script runs early, and in every frame", () => {
  const cs = manifest.content_scripts[0];
  // document_start is what keeps media covered before the first paint.
  assert.equal(cs.run_at, "document_start");
  // Without all_frames, embedded players and widgets are never blurred.
  assert.equal(cs.all_frames, true);
});

test("the content script is scoped to web pages", () => {
  for (const pattern of manifest.content_scripts[0].matches) {
    assert.match(pattern, /^https?:\/\//, `unexpected match pattern: ${pattern}`);
  }
});

test("only the permissions actually used are requested", () => {
  assert.deepEqual(manifest.permissions, ["storage"]);
});

test("every JavaScript file parses", () => {
  const scripts = walk().filter((rel) => rel.endsWith(".js"));
  assert.ok(scripts.length >= 4, "expected the extension's scripts to be found");
  for (const rel of scripts) {
    assert.doesNotThrow(
      () => new vm.Script(read(rel), { filename: rel }),
      `syntax error in ${rel}`,
    );
  }
});

test("nothing in the UI loads from the network", () => {
  // The previous build pulled a webfont from Google on every popup open. It
  // never arrived, and it told Google when the extension was being used.
  for (const rel of walk().filter((f) => /\.(html|css|js)$/.test(f))) {
    const body = read(rel).replace(/https?:\/\/www\.w3\.org\/2000\/svg/g, "");
    const remote = body.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) || [];
    assert.deepEqual(remote, [], `${rel} loads a remote resource`);
    const imported = body.match(/@import\s+(?:url\()?["']?https?:/gi) || [];
    assert.deepEqual(imported, [], `${rel} imports a remote stylesheet`);
  }
});

// ── Popup wiring ────────────────────────────────────────────────────────────

const popupHtml = read("popup/popup.html");
const popupJs = read("popup/popup.js");
const htmlIds = new Set([...popupHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

test("the popup loads its scripts and styles from disk", () => {
  const refs = [...popupHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    const resolved = path.resolve(SRC, "popup", ref);
    assert.ok(fs.existsSync(resolved), `popup references a missing file: ${ref}`);
  }
});

test("the popup loads the shared config before its own script", () => {
  assert.ok(
    popupHtml.indexOf("../shared/config.js") < popupHtml.indexOf("popup.js"),
    "popup.js reads RedBlurerConfig at load time",
  );
});

test("every element the popup script looks up exists in the markup", () => {
  const looked = [...popupJs.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(looked.length > 10, "expected the popup to wire up its controls");
  for (const id of looked) {
    assert.ok(htmlIds.has(id), `popup.js looks up #${id}, which the markup does not define`);
  }
});

test("every id in the markup is used, so nothing is left dangling", () => {
  for (const id of htmlIds) {
    const used =
      popupJs.includes(`"${id}"`) ||
      new RegExp(`(?:for|aria-labelledby|aria-describedby)="[^"]*\\b${id}\\b`).test(popupHtml);
    assert.ok(used, `#${id} is defined but never referenced`);
  }
});

test("every accessibility reference points at a real element", () => {
  const refs = [
    ...popupHtml.matchAll(/(?:aria-labelledby|aria-describedby|for)="([^"]+)"/g),
  ].flatMap((m) => m[1].split(/\s+/));
  assert.ok(refs.length > 0);
  for (const id of refs) {
    assert.ok(htmlIds.has(id), `accessibility attribute points at missing #${id}`);
  }
});

test("every control the user can operate is labelled", () => {
  const fields = [...popupHtml.matchAll(/<(input|textarea)\b[^>]*>/g)].map((m) => m[0]);
  for (const tag of fields) {
    // A file picker we drive from a button, and anything hidden, has no user
    // -facing presence to name.
    if (/\btype="file"/.test(tag) || /\bhidden\b/.test(tag)) continue;
    const id = (tag.match(/\bid="([^"]+)"/) || [])[1];
    const labelled =
      /aria-labelledby=|aria-label=/.test(tag) ||
      (id && new RegExp(`for="${id}"`).test(popupHtml));
    assert.ok(labelled, `control has no accessible name: ${tag.slice(0, 80)}`);
  }

  // A button takes its name from its own content, so it just needs content.
  const buttons = [...popupHtml.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.ok(buttons.length > 0, "expected the popup to have buttons");
  for (const [, attrs, body] of buttons) {
    const named = /aria-label=|aria-labelledby=/.test(attrs) || body.trim().length > 0;
    assert.ok(named, `button has no accessible name: <button${attrs}>`);
  }
});

test("the blur radius control matches the range the config enforces", () => {
  const Config = require("../src/shared/config.js");
  const slider = popupHtml.match(/<input[^>]*id="blurRadius"[^>]*>/)[0];
  assert.ok(slider.includes(`min="${Config.MIN_BLUR_RADIUS}"`), "slider min should match config");
  assert.ok(slider.includes(`max="${Config.MAX_BLUR_RADIUS}"`), "slider max should match config");
});

// ── Content script and styles ───────────────────────────────────────────────

const contentJs = read("content/content.js");
const contentCss = read("content/content.css");

test("the blur styles and the content script agree on the state attribute", () => {
  const Media = require("../src/shared/media.js");
  for (const state of [Media.STATE.BLURRED, Media.STATE.REVEALED]) {
    assert.ok(
      contentCss.includes(`[${Media.STATE_ATTR}="${state}"]`),
      `content.css has no rule for the "${state}" state`,
    );
  }
});

test("media we are not acting on is left entirely alone", () => {
  // Styling an "off" state would force filter: none over whatever the site
  // does to its own images. The attribute is removed instead.
  const Media = require("../src/shared/media.js");
  assert.equal(
    contentCss.includes(`[${Media.STATE_ATTR}="${Media.STATE.OFF}"]`),
    false,
    "there should be no stylesheet rule for the off state",
  );
  assert.ok(
    /clearState/.test(contentJs),
    "content.js should clear its attributes rather than mark elements off",
  );
});

test("the blur is not animated on, only off", () => {
  // Fading the blur in would show the content for a moment, which is the one
  // thing this extension must never do.
  const blurredRule = contentCss.match(
    /\[data-redblurer="blurred"\]\s*\{[^}]*\}/,
  );
  assert.ok(blurredRule, "expected a rule for the blurred state");
  assert.equal(
    /transition/.test(blurredRule[0]),
    false,
    "the blurred state must apply instantly",
  );
});

test("media is covered before settings have been read", () => {
  // Settings load asynchronously; without this guard there is a window where
  // the page is painted unblurred, which is exactly the failure to avoid.
  assert.ok(contentCss.includes("redblurer-boot"), "content.css needs a boot rule");
  assert.ok(contentJs.includes("BOOT_CLASS"), "content.js needs to apply the boot class");
});

test("autoplay is stopped with a DOM event, not a prototype patch", () => {
  // Content scripts run in an isolated world, so patching
  // HTMLVideoElement.prototype here is invisible to the page's own scripts.
  assert.equal(
    /HTMLVideoElement\.prototype\s*\.\s*play\s*=/.test(contentJs),
    false,
    "prototype patching does not cross the isolated world boundary",
  );
  assert.ok(
    /addEventListener\(\s*["']play["']/.test(contentJs),
    "a capturing play listener is what actually works",
  );
});

test("the content script never restyles a media element's parent", () => {
  // The previous build forced every parent to block display with hidden
  // overflow, which flattened flex and grid layouts across the web.
  assert.equal(/parentElement/.test(contentJs), false);
  assert.equal(/overflow\s*:\s*hidden/.test(contentCss), false);
});
