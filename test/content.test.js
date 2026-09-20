/**
 * The content script, exercised against a real DOM.
 *
 * jsdom does not lay pages out, so every element measures zero. That is the
 * lazy-loaded case the rules already treat as "blur it", and tests that care
 * about size stub getBoundingClientRect directly.
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
const { loadContentScript, dispatch } = missing
  ? {}
  : require("../tools/dom-harness.js");

const STATE = "data-redblurer";
const stateOf = (el) => el.getAttribute(STATE);

/**
 * A video that believes it is playing, and records being stopped.
 * `startPlaying` mirrors what a real element does just before it fires a
 * play event: it stops being paused.
 */
function playingVideo(document) {
  const video = document.createElement("video");
  let paused = false;
  video.pauseCalls = 0;
  Object.defineProperty(video, "paused", { get: () => paused, configurable: true });
  video.pause = () => {
    paused = true;
    video.pauseCalls += 1;
  };
  video.startPlaying = () => {
    paused = false;
  };
  return video;
}

/** Give an element a measured size, since jsdom will not. */
function sized(el, width, height) {
  el.getBoundingClientRect = () => ({ width, height, top: 0, left: 0, right: width, bottom: height });
  return el;
}

// ── Start-up ────────────────────────────────────────────────────────────────

test("media is covered before settings have loaded", async () => {
  const env = await loadContentScript({ body: "<img src='a.jpg'>", settle: false });
  assert.ok(
    env.document.documentElement.classList.contains("redblurer-boot"),
    "the boot guard should be up while storage is still being read",
  );
});

test("the boot guard comes down once settings arrive", async () => {
  const env = await loadContentScript({ body: "<img src='a.jpg'>" });
  assert.equal(env.document.documentElement.classList.contains("redblurer-boot"), false);
});

test("images already on the page are blurred", async () => {
  const env = await loadContentScript({ body: "<img src='a.jpg'><img src='b.jpg'>" });
  for (const img of env.document.querySelectorAll("img")) {
    assert.equal(stateOf(img), "blurred");
  }
});

test("a div with an inline background image is blurred", async () => {
  const env = await loadContentScript({
    body: `<div id="hero" style="background-image: url(photo.jpg)"></div>`,
  });
  assert.equal(stateOf(env.document.getElementById("hero")), "blurred");
});

test("ordinary elements are left alone", async () => {
  const env = await loadContentScript({ body: `<div id="plain">text</div>` });
  assert.equal(stateOf(env.document.getElementById("plain")), null);
});

test("an element can opt out with the skip attribute", async () => {
  const env = await loadContentScript({
    body: `<img id="logo" src="logo.svg" data-redblurer-skip>`,
  });
  assert.equal(stateOf(env.document.getElementById("logo")), null);
});

// ── Scope ───────────────────────────────────────────────────────────────────

test("a host outside the domain list is left untouched", async () => {
  // Untouched means no attribute at all. Marking such media with an "off"
  // state would force filter: none over any filter the site applies itself.
  const env = await loadContentScript({
    url: "https://news.example.org/story",
    body: "<img src='a.jpg'>",
    stored: { enabled: true, blurEverywhere: false, domains: ["reddit.com"] },
  });
  assert.equal(stateOf(env.document.querySelector("img")), null);
});

test("a subdomain of a listed domain is blurred", async () => {
  const env = await loadContentScript({
    url: "https://old.reddit.com/r/all",
    body: "<img src='a.jpg'>",
    stored: { enabled: true, blurEverywhere: false, domains: ["reddit.com"] },
  });
  assert.equal(stateOf(env.document.querySelector("img")), "blurred");
});

test("settings saved by the previous version still apply", async () => {
  const env = await loadContentScript({
    url: "https://twitter.com/home",
    body: "<img src='a.jpg'>",
    stored: { blurEnabled: true, blockAll: false, blockedDomains: ["twitter.com"] },
  });
  assert.equal(stateOf(env.document.querySelector("img")), "blurred");
});

// ── Reacting to settings ────────────────────────────────────────────────────

test("switching the extension off reveals the page", async () => {
  const env = await loadContentScript({ body: "<img src='a.jpg'>" });
  env.chrome.write({ enabled: false });
  await env.settle();
  assert.equal(stateOf(env.document.querySelector("img")), null);
});

test("switching it off and back on blurs the page again", async () => {
  // The previous build marked each element handled exactly once, so this
  // sequence left every image permanently visible. It is the reason element
  // state is re-derived from settings rather than latched.
  const env = await loadContentScript({ body: "<img src='a.jpg'>" });
  const img = env.document.querySelector("img");

  env.chrome.write({ enabled: false });
  await env.settle();
  assert.equal(stateOf(img), null);

  env.chrome.write({ enabled: true });
  await env.settle();
  assert.equal(stateOf(img), "blurred");
});

test("adding a domain brings the current page into scope", async () => {
  const env = await loadContentScript({
    url: "https://reddit.com/r/all",
    body: "<img src='a.jpg'>",
    stored: { enabled: true, blurEverywhere: false, domains: [] },
  });
  assert.equal(stateOf(env.document.querySelector("img")), null);

  env.chrome.write({ domains: ["reddit.com"] });
  await env.settle();
  assert.equal(stateOf(env.document.querySelector("img")), "blurred");
});

test("locking the blur is announced on the document", async () => {
  const env = await loadContentScript({ body: "<img src='a.jpg'>" });
  assert.equal(env.document.documentElement.classList.contains("redblurer-locked"), false);

  env.chrome.write({ lockBlur: true });
  await env.settle();
  assert.ok(env.document.documentElement.classList.contains("redblurer-locked"));
});

test("the blur radius reaches the stylesheet", async () => {
  const env = await loadContentScript({ body: "<img src='a.jpg'>" });
  const root = env.document.documentElement;
  assert.equal(root.style.getPropertyValue("--redblurer-radius"), "18px");

  env.chrome.write({ blurRadius: 40 });
  await env.settle();
  assert.equal(root.style.getPropertyValue("--redblurer-radius"), "40px");
});

test("an out-of-range radius from storage is clamped, not trusted", async () => {
  const env = await loadContentScript({
    body: "<img src='a.jpg'>",
    stored: { blurRadius: 100000 },
  });
  assert.equal(env.document.documentElement.style.getPropertyValue("--redblurer-radius"), "60px");
});

// ── Keeping up with the page ────────────────────────────────────────────────

test("images added later are blurred too", async () => {
  const env = await loadContentScript({ body: "" });
  const img = env.document.createElement("img");
  img.src = "late.jpg";
  env.document.body.appendChild(img);

  await env.settle();
  assert.equal(stateOf(img), "blurred");
});

test("images added inside a new subtree are blurred", async () => {
  const env = await loadContentScript({ body: "" });
  const card = env.document.createElement("article");
  card.innerHTML = `<div class="meta"></div><img src="post.jpg">`;
  env.document.body.appendChild(card);

  await env.settle();
  assert.equal(stateOf(card.querySelector("img")), "blurred");
});

test("a background image applied later is picked up", async () => {
  const env = await loadContentScript({ body: `<div id="hero"></div>` });
  const hero = env.document.getElementById("hero");
  assert.equal(stateOf(hero), null);

  hero.setAttribute("style", "background-image: url(photo.jpg)");
  await env.settle();
  assert.equal(stateOf(hero), "blurred");
});

test("page chrome stays sharp", async () => {
  const env = await loadContentScript({ body: "" });
  const icon = sized(env.document.createElement("img"), 16, 16);
  icon.src = "favicon.png";
  env.document.body.appendChild(icon);

  await env.settle();
  assert.equal(stateOf(icon), null, "a 16px icon is not worth blurring");
});

test("a full-size photo is blurred", async () => {
  const env = await loadContentScript({ body: "" });
  const photo = sized(env.document.createElement("img"), 640, 480);
  photo.src = "photo.jpg";
  env.document.body.appendChild(photo);

  await env.settle();
  assert.equal(stateOf(photo), "blurred");
});

// ── Video ───────────────────────────────────────────────────────────────────

test("a blurred video is stopped and stripped of autoplay", async () => {
  const env = await loadContentScript({ body: "" });
  const video = playingVideo(env.document);
  video.setAttribute("autoplay", "");
  env.document.body.appendChild(video);

  await env.settle();
  assert.equal(stateOf(video), "blurred");
  assert.ok(video.pauseCalls > 0, "a blurred video should not keep playing");
  assert.equal(video.hasAttribute("autoplay"), false);
});

test("a video that starts itself again is stopped again", async () => {
  // Sites re-start their players from their own scripts. A prototype patch in
  // the content script cannot see those calls, but the play event can.
  const env = await loadContentScript({ body: "" });
  const video = playingVideo(env.document);
  env.document.body.appendChild(video);
  await env.settle();

  const before = video.pauseCalls;
  video.startPlaying();
  dispatch(video, "play");
  assert.ok(video.pauseCalls > before, "the play event should be answered with a pause");
});

test("a video is left alone once the page is out of scope", async () => {
  const env = await loadContentScript({ body: "" });
  const video = playingVideo(env.document);
  env.document.body.appendChild(video);
  await env.settle();

  env.chrome.write({ enabled: false });
  await env.settle();

  const before = video.pauseCalls;
  video.startPlaying();
  dispatch(video, "play");
  assert.equal(video.pauseCalls, before, "with blurring off, playback is none of our business");
});

// ── Stylesheet background images ────────────────────────────────────────────
//
// The cheap path only sees inline styles. These cover the deep scan, which
// asks the browser for computed styles in idle time. jsdom has no
// requestIdleCallback, so the content script falls back to a timer and the
// tests wait for it.

const DEEP_SCAN_WAIT = 160;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CARD_CSS = `<style>
  .card { background-image: url(photo.jpg); }
  .plain { background-color: #eee; }
</style>`;

test("a background image set by a stylesheet is found and blurred", async () => {
  const env = await loadContentScript({
    head: CARD_CSS,
    body: `<div id="card" class="card"></div>`,
  });
  await pause(DEEP_SCAN_WAIT);
  await env.settle();

  assert.equal(stateOf(env.document.getElementById("card")), "blurred");
});

test("an element with no background image is left alone", async () => {
  const env = await loadContentScript({
    head: CARD_CSS,
    body: `<div id="plain" class="plain"></div>`,
  });
  await pause(DEEP_SCAN_WAIT);
  await env.settle();

  assert.equal(stateOf(env.document.getElementById("plain")), null);
});

test("the deep scan can be switched off", async () => {
  const env = await loadContentScript({
    head: CARD_CSS,
    body: `<div id="card" class="card"></div>`,
    stored: { deepScan: false },
  });
  await pause(DEEP_SCAN_WAIT);
  await env.settle();

  assert.equal(stateOf(env.document.getElementById("card")), null);
});

test("a full-page backdrop is never blurred", async () => {
  // Blurring one of these would blur every word sitting on top of it, which
  // would make the page unreadable rather than private.
  const env = await loadContentScript({
    head: CARD_CSS,
    body: `<div id="card" class="card"></div>`,
  });
  const card = env.document.getElementById("card");
  sized(card, env.window.innerWidth, env.window.innerHeight);

  await pause(DEEP_SCAN_WAIT);
  await env.settle();
  assert.equal(stateOf(card), null);
});

test("a stylesheet background too small to matter is skipped", async () => {
  const env = await loadContentScript({
    head: CARD_CSS,
    body: `<div id="card" class="card"></div>`,
  });
  sized(env.document.getElementById("card"), 20, 20);

  await pause(DEEP_SCAN_WAIT);
  await env.settle();
  assert.equal(stateOf(env.document.getElementById("card")), null);
});

test("the body is never treated as media", async () => {
  const env = await loadContentScript({
    head: `<style>body { background-image: url(wallpaper.jpg); }</style>`,
    body: `<p>readable text</p>`,
  });
  await pause(DEEP_SCAN_WAIT);
  await env.settle();

  assert.equal(stateOf(env.document.body), null);
  assert.equal(stateOf(env.document.documentElement), null);
});

test("a stylesheet background added later is picked up", async () => {
  const env = await loadContentScript({ head: CARD_CSS, body: "" });
  const card = env.document.createElement("div");
  card.id = "card";
  card.className = "card";
  env.document.body.appendChild(card);

  await pause(DEEP_SCAN_WAIT);
  await env.settle();
  assert.equal(stateOf(card), "blurred");
});

// ── Re-hiding when you look away ────────────────────────────────────────────

/** Put the pointer over an element, piercing jsdom's lack of hit testing. */
function hover(env, el) {
  env.document.elementsFromPoint = () => [el];
  const event = new env.window.MouseEvent("pointermove", {
    bubbles: true,
    clientX: 10,
    clientY: 10,
  });
  env.document.dispatchEvent(event);
}

async function revealOne(env) {
  const img = env.document.querySelector("img");
  hover(env, img);
  await env.settle();
  assert.equal(stateOf(img), "revealed", "precondition: the image should be revealed");
  return img;
}

test("switching away puts revealed media back behind the blur", async () => {
  const env = await loadContentScript({
    body: "<img src='a.jpg'>",
    stored: { keepRevealed: true, rehideOnBlur: true },
  });
  const img = await revealOne(env);

  env.window.dispatchEvent(new env.window.Event("blur"));
  await env.settle();

  assert.equal(stateOf(img), "blurred");
});

test("hiding the tab does the same", async () => {
  const env = await loadContentScript({
    body: "<img src='a.jpg'>",
    stored: { keepRevealed: true, rehideOnBlur: true },
  });
  const img = await revealOne(env);

  Object.defineProperty(env.document, "visibilityState", {
    value: "hidden",
    configurable: true,
  });
  env.document.dispatchEvent(new env.window.Event("visibilitychange"));
  await env.settle();

  assert.equal(stateOf(img), "blurred");
});

test("re-hiding on switch away can be turned off", async () => {
  const env = await loadContentScript({
    body: "<img src='a.jpg'>",
    stored: { keepRevealed: true, rehideOnBlur: false },
  });
  const img = await revealOne(env);

  env.window.dispatchEvent(new env.window.Event("blur"));
  await env.settle();

  assert.equal(stateOf(img), "revealed");
});

test("sitting idle puts revealed media back behind the blur", async () => {
  const env = await loadContentScript({
    body: "<img src='a.jpg'>",
    stored: { keepRevealed: true, rehideAfterSeconds: 1, rehideOnBlur: false },
  });
  const img = await revealOne(env);

  await pause(1200);
  await env.settle();
  assert.equal(stateOf(img), "blurred");
});

test("an idle delay of zero means never", async () => {
  const env = await loadContentScript({
    body: "<img src='a.jpg'>",
    stored: { keepRevealed: true, rehideAfterSeconds: 0, rehideOnBlur: false },
  });
  const img = await revealOne(env);

  await pause(600);
  await env.settle();
  assert.equal(stateOf(img), "revealed");
});
