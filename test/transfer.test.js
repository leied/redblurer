const test = require("node:test");
const assert = require("node:assert/strict");
const Config = require("../src/shared/config.js");

test("an export carries a version and a normalized config", () => {
  const payload = Config.buildExport(
    { blurEnabled: false, blockedDomains: ["WWW.X.com"] },
    "2026-09-20T00:00:00.000Z",
  );
  assert.equal(payload.app, "RedBlurer");
  assert.equal(payload.version, Config.CONFIG_VERSION);
  assert.equal(payload.exportedAt, "2026-09-20T00:00:00.000Z");
  assert.equal(payload.config.enabled, false);
  assert.deepEqual(payload.config.domains, ["x.com"]);
});

test("serializeExport produces JSON a person can read", () => {
  const text = Config.serializeExport(null, "2026-09-20T00:00:00.000Z");
  assert.ok(text.includes("\n  "), "should be indented");
  assert.ok(text.endsWith("\n"), "should end with a newline");
  assert.deepEqual(JSON.parse(text), Config.buildExport(null, "2026-09-20T00:00:00.000Z"));
});

test("export and import round-trip without losing anything", () => {
  const original = Config.normalizeConfig({
    enabled: false,
    blurEverywhere: false,
    domains: ["x.com", "reddit.com"],
    keepRevealed: true,
    lockBlur: true,
    blurRadius: 42,
  });
  const result = Config.parseImport(Config.serializeExport(original));
  assert.ok(result.ok);
  assert.deepEqual(result.config, original);
});

test("parseImport accepts a config exported by the old build", () => {
  const legacy = JSON.stringify({
    blurEnabled: true,
    blockAll: false,
    blockedDomains: ["twitter.com"],
    persistentUnblur: true,
    noHoverUnblur: false,
  });
  const result = Config.parseImport(legacy);
  assert.ok(result.ok);
  assert.equal(result.config.blurEverywhere, false);
  assert.deepEqual(result.config.domains, ["twitter.com"]);
  assert.equal(result.config.keepRevealed, true);
});

test("parseImport accepts an already-parsed object", () => {
  const result = Config.parseImport({ config: { enabled: false } });
  assert.ok(result.ok);
  assert.equal(result.config.enabled, false);
});

test("parseImport explains itself when a file is unusable", () => {
  const cases = [
    ["", /empty/i],
    ["   ", /empty/i],
    ["{not json", /valid JSON/i],
    ["[1,2,3]", /RedBlurer config/i],
    ["null", /RedBlurer config/i],
    ['"a string"', /RedBlurer config/i],
    ['{"unrelated": true}', /RedBlurer settings/i],
  ];
  for (const [input, pattern] of cases) {
    const result = Config.parseImport(input);
    assert.equal(result.ok, false, `should reject: ${input}`);
    assert.match(result.error, pattern);
    // The message is shown to a person, so it has to read like a sentence.
    assert.ok(/[.!]$/.test(result.error), `should be a sentence: ${result.error}`);
  }
});

test("a hostile import cannot smuggle extra keys into storage", () => {
  const result = Config.parseImport(
    JSON.stringify({ enabled: true, __proto__polluted: 1, extra: "x" }),
  );
  assert.ok(result.ok);
  assert.deepEqual(Object.keys(result.config).sort(), [...Config.KEYS].sort());
});

test("an import with an out-of-range radius is clamped, not rejected", () => {
  const result = Config.parseImport(JSON.stringify({ enabled: true, blurRadius: 5000 }));
  assert.ok(result.ok);
  assert.equal(result.config.blurRadius, Config.MAX_BLUR_RADIUS);
});
