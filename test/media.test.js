const test = require("node:test");
const assert = require("node:assert/strict");
const Media = require("../src/shared/media.js");

/** A stand-in for a DOM element, carrying only what the rules actually read. */
function fakeEl(tagName, attrs = {}, inlineBackground = "") {
  return {
    tagName,
    getAttribute: (name) =>
      Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null,
    style: { backgroundImage: inlineBackground },
  };
}

test("images and videos are media whatever their case", () => {
  assert.ok(Media.isMediaElement(fakeEl("IMG")));
  assert.ok(Media.isMediaElement(fakeEl("img")));
  assert.ok(Media.isMediaElement(fakeEl("VIDEO")));
});

test("ordinary elements are not media", () => {
  assert.equal(Media.isMediaElement(fakeEl("DIV")), false);
  assert.equal(Media.isMediaElement(fakeEl("SPAN")), false);
  assert.equal(Media.isMediaElement(null), false);
  assert.equal(Media.isMediaElement(undefined), false);
  assert.equal(Media.isMediaElement({}), false);
});

test("an inline background image counts as media", () => {
  const el = fakeEl("DIV", { style: "background-image: url(photo.jpg)" }, 'url("photo.jpg")');
  assert.ok(Media.isMediaElement(el));
});

test("a cleared background image does not", () => {
  // Frameworks clear a background by setting it to none, and the CSS
  // attribute selector still matches that, so the value has to be checked.
  const el = fakeEl("DIV", { style: "background-image: none" }, "none");
  assert.equal(Media.isMediaElement(el), false);
});

test("a background colour alone does not", () => {
  const el = fakeEl("DIV", { style: "background: #fff" }, "");
  assert.equal(Media.isMediaElement(el), false);
});

test("a background gradient counts, since it can carry an image", () => {
  const el = fakeEl("DIV", { style: "background-image: linear-gradient(red, blue)" },
    "linear-gradient(red, blue)");
  assert.ok(Media.isMediaElement(el));
});

test("an element can opt out", () => {
  const el = fakeEl("IMG", { "data-redblurer-skip": "" });
  assert.ok(Media.isExcluded(el));
  assert.equal(Media.shouldBlurElement(el, { width: 400, height: 300 }), false);
});

test("page chrome is left alone", () => {
  // Favicons, emoji and tracking pixels: blurring them breaks the page and
  // hides nothing worth hiding.
  assert.ok(Media.isTooSmall({ width: 16, height: 16 }));
  assert.ok(Media.isTooSmall({ width: 1, height: 1 }));
  assert.ok(Media.isTooSmall({ width: 47, height: 47 }));
});

test("anything large in either dimension is treated as content", () => {
  assert.equal(Media.isTooSmall({ width: 48, height: 48 }), false);
  assert.equal(Media.isTooSmall({ width: 600, height: 20 }), false);
  assert.equal(Media.isTooSmall({ width: 20, height: 600 }), false);
});

test("an unmeasured element is not skipped as small", () => {
  // Lazy-loaded images measure zero before layout. Skipping them would leave
  // the most common case on a feed unblurred, which is the whole failure mode
  // this extension exists to prevent.
  assert.equal(Media.isTooSmall({ width: 0, height: 0 }), false);
  assert.equal(Media.isTooSmall(null), false);
  assert.equal(Media.isTooSmall(undefined), false);
});

test("shouldBlurElement combines the rules", () => {
  const photo = fakeEl("IMG");
  assert.ok(Media.shouldBlurElement(photo, { width: 500, height: 400 }));
  assert.equal(Media.shouldBlurElement(photo, { width: 16, height: 16 }), false);
  assert.equal(Media.shouldBlurElement(fakeEl("DIV"), { width: 500, height: 400 }), false);
});

test("blur is on by default when the page is in scope", () => {
  assert.equal(Media.nextState({ active: true }), Media.STATE.BLURRED);
});

test("an out-of-scope page turns everything off", () => {
  assert.equal(Media.nextState({ active: false }), Media.STATE.OFF);
  assert.equal(
    Media.nextState({ active: false, revealed: true, keepRevealed: true }),
    Media.STATE.OFF,
  );
});

test("keep-revealed only applies to what was actually revealed", () => {
  assert.equal(
    Media.nextState({ active: true, revealed: true, keepRevealed: true }),
    Media.STATE.REVEALED,
  );
  assert.equal(
    Media.nextState({ active: true, revealed: false, keepRevealed: true }),
    Media.STATE.BLURRED,
  );
});

test("turning keep-revealed off re-blurs what was revealed", () => {
  assert.equal(
    Media.nextState({ active: true, revealed: true, keepRevealed: false }),
    Media.STATE.BLURRED,
  );
});

test("locking the blur overrides every reveal path", () => {
  assert.equal(
    Media.nextState({ active: true, revealed: true, keepRevealed: true, lockBlur: true }),
    Media.STATE.BLURRED,
  );
});

test("state depends only on the current settings, never on history", () => {
  // This is the invariant behind the worst bug in the previous build: it
  // marked each element handled once, so switching the extension off and back
  // on left every image permanently visible. A pure function cannot do that.
  const settings = { active: true, revealed: false, keepRevealed: false, lockBlur: false };

  const first = Media.nextState(settings);
  Media.nextState({ ...settings, active: false });          // toggled off
  const afterToggling = Media.nextState(settings);          // and on again

  assert.equal(afterToggling, first);
  assert.equal(afterToggling, Media.STATE.BLURRED);
});

test("the media selector and the tag list agree with each other", () => {
  for (const tag of Media.MEDIA_TAGS) {
    assert.ok(
      Media.MEDIA_SELECTOR.includes(tag.toLowerCase()),
      `${tag} should appear in the query selector`,
    );
  }
});
