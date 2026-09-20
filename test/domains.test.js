const test = require("node:test");
const assert = require("node:assert/strict");
const Config = require("../src/shared/config.js");

test("normalizeDomain strips the parts of a URL that are not the host", () => {
  const cases = {
    "example.com": "example.com",
    "  Example.COM  ": "example.com",
    "https://example.com": "example.com",
    "http://example.com/feed?tab=top#x": "example.com",
    "example.com:8443": "example.com",
    "user:secret@mail.google.com/inbox": "mail.google.com",
    "example.com.": "example.com",
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(Config.normalizeDomain(input), expected, `input: ${input}`);
  }
});

test("normalizeDomain folds away the ways people write 'and subdomains'", () => {
  assert.equal(Config.normalizeDomain("*.reddit.com"), "reddit.com");
  assert.equal(Config.normalizeDomain(".reddit.com"), "reddit.com");
  assert.equal(Config.normalizeDomain("www.reddit.com"), "reddit.com");
});

test("normalizeDomain keeps a www that is not a subdomain prefix", () => {
  assert.equal(Config.normalizeDomain("www.com"), "www.com");
});

test("normalizeDomain accepts hosts without a public suffix", () => {
  assert.equal(Config.normalizeDomain("localhost"), "localhost");
  assert.equal(Config.normalizeDomain("192.168.1.9"), "192.168.1.9");
});

test("normalizeDomain rejects what is not a hostname", () => {
  const junk = [
    "",
    "   ",
    "not a domain",
    "example",
    "-example.com",
    "example-.com",
    "exa mple.com",
    "999.999.999.999",
    null,
    undefined,
    42,
  ];
  for (const input of junk) {
    assert.equal(Config.normalizeDomain(input), "", `input: ${String(input)}`);
  }
});

test("parseDomainList cleans, de-duplicates and preserves order", () => {
  const parsed = Config.parseDomainList(
    "x.com\n https://www.X.com/home \nreddit.com, instagram.com\n\nnot a domain\n",
  );
  assert.deepEqual(parsed, ["x.com", "reddit.com", "instagram.com"]);
});

test("parseDomainList accepts an array as readily as text", () => {
  assert.deepEqual(Config.parseDomainList(["A.com", "a.com"]), ["a.com"]);
});

test("formatDomainList round-trips through parseDomainList", () => {
  const domains = ["x.com", "reddit.com"];
  assert.deepEqual(Config.parseDomainList(Config.formatDomainList(domains)), domains);
});

test("hostMatchesDomain covers the host itself and its subdomains", () => {
  assert.ok(Config.hostMatchesDomain("example.com", "example.com"));
  assert.ok(Config.hostMatchesDomain("www.example.com", "example.com"));
  assert.ok(Config.hostMatchesDomain("a.b.example.com", "example.com"));
});

test("hostMatchesDomain does not match a host that merely ends with the name", () => {
  assert.equal(Config.hostMatchesDomain("notexample.com", "example.com"), false);
  assert.equal(Config.hostMatchesDomain("example.com.evil.net", "example.com"), false);
  assert.equal(Config.hostMatchesDomain("example.co", "example.com"), false);
});

test("shouldBlurHost honours the global switch above everything else", () => {
  const off = { enabled: false, blurEverywhere: true, domains: ["x.com"] };
  assert.equal(Config.shouldBlurHost("x.com", off), false);
});

test("shouldBlurHost blurs everywhere when asked to", () => {
  const cfg = { enabled: true, blurEverywhere: true, domains: [] };
  assert.ok(Config.shouldBlurHost("anything.example", cfg));
});

test("shouldBlurHost consults the list only when blur-everywhere is off", () => {
  const cfg = { enabled: true, blurEverywhere: false, domains: ["x.com"] };
  assert.ok(Config.shouldBlurHost("x.com", cfg));
  assert.ok(Config.shouldBlurHost("mobile.x.com", cfg));
  assert.equal(Config.shouldBlurHost("reddit.com", cfg), false);
});

test("an empty list with blur-everywhere off blurs nothing", () => {
  // The previous build treated an empty list as "blur everywhere", which made
  // the list feel broken the moment you cleared it.
  const cfg = { enabled: true, blurEverywhere: false, domains: [] };
  assert.equal(Config.shouldBlurHost("x.com", cfg), false);
});

test("shouldBlurUrl ignores non-web schemes", () => {
  const cfg = { enabled: true, blurEverywhere: true };
  assert.ok(Config.shouldBlurUrl("https://example.com/a", cfg));
  assert.ok(Config.shouldBlurUrl("http://example.com/a", cfg));
  assert.equal(Config.shouldBlurUrl("chrome://extensions", cfg), false);
  assert.equal(Config.shouldBlurUrl("file:///home/me/x.png", cfg), false);
  assert.equal(Config.shouldBlurUrl("about:blank", cfg), false);
  assert.equal(Config.shouldBlurUrl("not a url", cfg), false);
});
