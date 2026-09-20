const test = require("node:test");
const assert = require("node:assert/strict");
const Config = require("../src/shared/config.js");

test("a fresh install blurs everywhere", () => {
  // A privacy tool that does nothing until configured fails quietly, which is
  // the worst way for this particular tool to fail.
  const cfg = Config.normalizeConfig(null);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.blurEverywhere, true);
});

test("normalizeConfig always returns every key", () => {
  const cfg = Config.normalizeConfig({});
  assert.deepEqual(Object.keys(cfg).sort(), [...Config.KEYS].sort());
});

test("normalizeConfig drops unknown keys", () => {
  const cfg = Config.normalizeConfig({ enabled: false, sneaky: "value" });
  assert.equal("sneaky" in cfg, false);
  assert.equal(cfg.enabled, false);
});

test("normalizeConfig coerces nonsense to the defaults", () => {
  const cfg = Config.normalizeConfig({
    enabled: "yes",
    blurEverywhere: 1,
    domains: "x.com",
    keepRevealed: null,
    lockBlur: [],
    blurRadius: "not a number",
  });
  assert.equal(cfg.enabled, Config.DEFAULTS.enabled);
  assert.equal(cfg.blurEverywhere, Config.DEFAULTS.blurEverywhere);
  assert.deepEqual(cfg.domains, ["x.com"]);
  assert.equal(cfg.keepRevealed, Config.DEFAULTS.keepRevealed);
  assert.equal(cfg.lockBlur, Config.DEFAULTS.lockBlur);
  assert.equal(cfg.blurRadius, Config.DEFAULTS.blurRadius);
});

test("normalizeConfig never mutates or aliases its input", () => {
  const input = { domains: ["x.com"] };
  const cfg = Config.normalizeConfig(input);
  cfg.domains.push("reddit.com");
  assert.deepEqual(input.domains, ["x.com"]);
});

test("blurRadius is clamped to a usable range", () => {
  assert.equal(Config.clampBlurRadius(0), Config.MIN_BLUR_RADIUS);
  assert.equal(Config.clampBlurRadius(-40), Config.MIN_BLUR_RADIUS);
  assert.equal(Config.clampBlurRadius(9000), Config.MAX_BLUR_RADIUS);
  assert.equal(Config.clampBlurRadius(22.6), 23);
  assert.equal(Config.clampBlurRadius(NaN), Config.DEFAULT_BLUR_RADIUS);
  assert.equal(Config.clampBlurRadius(Infinity), Config.DEFAULT_BLUR_RADIUS);
});

test("v1 setting names are migrated, so an upgrade keeps your settings", () => {
  const cfg = Config.normalizeConfig({
    blurEnabled: false,
    blockAll: false,
    blockedDomains: ["twitter.com", "reddit.com"],
    persistentUnblur: true,
    noHoverUnblur: true,
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.blurEverywhere, false);
  assert.deepEqual(cfg.domains, ["twitter.com", "reddit.com"]);
  assert.equal(cfg.keepRevealed, true);
  assert.equal(cfg.lockBlur, true);
});

test("a v2 key wins over the v1 key it replaced", () => {
  const cfg = Config.normalizeConfig({ enabled: true, blurEnabled: false });
  assert.equal(cfg.enabled, true);
});

test("mergeConfig applies only the keys present in the patch", () => {
  const base = Config.normalizeConfig({
    enabled: true,
    blurEverywhere: false,
    domains: ["x.com"],
    blurRadius: 30,
  });
  const merged = Config.mergeConfig(base, { enabled: false });
  assert.equal(merged.enabled, false);
  assert.equal(merged.blurEverywhere, false);
  assert.deepEqual(merged.domains, ["x.com"]);
  assert.equal(merged.blurRadius, 30);
});

test("mergeConfig normalizes what the patch puts in", () => {
  const merged = Config.mergeConfig(null, {
    domains: ["HTTPS://WWW.X.com/home"],
    blurRadius: 999,
  });
  assert.deepEqual(merged.domains, ["x.com"]);
  assert.equal(merged.blurRadius, Config.MAX_BLUR_RADIUS);
});

test("mergeConfig ignores an absent or malformed patch", () => {
  const base = Config.normalizeConfig({ enabled: false });
  assert.ok(Config.configsEqual(Config.mergeConfig(base, null), base));
  assert.ok(Config.configsEqual(Config.mergeConfig(base, "nope"), base));
});

test("configsEqual compares settings, not object identity", () => {
  const a = { enabled: true, domains: ["x.com", "y.com"] };
  const b = { blurEnabled: true, blockedDomains: ["X.com", "y.com"] };
  assert.ok(Config.configsEqual(a, b));
  assert.equal(Config.configsEqual(a, { ...a, domains: ["y.com", "x.com"] }), false);
  assert.equal(Config.configsEqual(a, { ...a, enabled: false }), false);
});
