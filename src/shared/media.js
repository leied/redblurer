/**
 * shared/media.js — deciding what counts as media worth blurring.
 *
 * Kept separate from content.js and free of live DOM APIs: every function here
 * takes plain, duck-typed values, so the classification rules can be unit
 * tested in Node without a headless browser.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
  if (root) root.RedBlurerMedia = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** Matches the element types we blur. Used for queries and for mutations. */
  const MEDIA_SELECTOR = 'img, video, [style*="background-image"]';

  /** Attribute carrying our per-element state, so re-blurring is idempotent. */
  const STATE_ATTR = "data-redblurer";

  const STATE = Object.freeze({
    BLURRED: "blurred",
    REVEALED: "revealed",
    OFF: "off",
  });

  /** Opt-out hook a page (or a user script) can set to exclude an element. */
  const SKIP_ATTR = "data-redblurer-skip";

  /**
   * Set on elements the deep scan found carrying a stylesheet background
   * image, so the expensive computed-style lookup happens only once.
   */
  const BG_ATTR = "data-redblurer-bg";

  /**
   * Tags the deep scan never needs to look at. `html` and `body` are the
   * important ones: a page background lives there, and blurring it would
   * blur the entire document, text and all.
   */
  const DEEP_SCAN_SKIP_TAGS = Object.freeze([
    "HTML", "HEAD", "BODY", "SCRIPT", "STYLE", "LINK", "META", "TITLE",
    "BASE", "NOSCRIPT", "TEMPLATE", "IFRAME", "BR", "HR", "OPTION",
    "IMG", "VIDEO", "SVG", "PATH", "G", "CIRCLE", "RECT", "USE", "DEFS",
  ]);

  /** Most elements examined in one deep-scan pass, so a huge page cannot stall. */
  const DEEP_SCAN_BATCH = 1500;

  /**
   * An element covering this much of the viewport in both directions is a
   * page backdrop, not a piece of content.
   */
  const PAGE_BACKGROUND_RATIO = 0.9;

  /**
   * Anything smaller than this in both dimensions is chrome, not content:
   * spacer GIFs, tracking pixels, favicons, emoji, avatars in a nav bar.
   * Blurring them wrecks the page for no privacy gain.
   */
  const MIN_MEDIA_PX = 48;

  /** Tags we blur directly, regardless of styling. */
  const MEDIA_TAGS = Object.freeze(["IMG", "VIDEO"]);

  function tagOf(el) {
    return el && typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  }

  function attrOf(el, name) {
    if (!el || typeof el.getAttribute !== "function") return null;
    try {
      return el.getAttribute(name);
    } catch {
      return null;
    }
  }

  /**
   * Does this element carry a real inline background-image?
   * `[style*="background-image"]` also matches `background-image: none`, which
   * is how a lot of frameworks clear one, so re-check the value.
   *
   * @param {object} el
   * @returns {boolean}
   */
  function hasBackgroundImage(el) {
    const style = attrOf(el, "style");
    if (!style || !/background(-image)?\s*:/i.test(style)) return false;
    const inline = el && el.style ? el.style.backgroundImage : "";
    if (typeof inline === "string" && inline) {
      return inline !== "none" && /url\(|gradient\(/i.test(inline);
    }
    return /background(-image)?\s*:[^;]*url\(/i.test(style);
  }

  /**
   * Is this element one we should blur at all?
   * @param {object} el
   * @returns {boolean}
   */
  function isMediaElement(el) {
    if (!el) return false;
    const tag = tagOf(el);
    if (MEDIA_TAGS.includes(tag)) return true;
    // The deep scan already resolved this one; trust its answer.
    if (attrOf(el, BG_ATTR) !== null) return true;
    return hasBackgroundImage(el);
  }

  /**
   * Does a computed background-image value carry an actual image?
   * @param {unknown} value the computed `background-image`
   * @returns {boolean}
   */
  function hasComputedBackgroundImage(value) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || text === "none") return false;
    return /\burl\(/i.test(text);
  }

  /**
   * Is this element worth asking the browser for computed styles about?
   * Cheap checks only; the expensive part happens after this says yes.
   *
   * @param {object} el
   * @returns {boolean}
   */
  function isDeepScanCandidate(el) {
    if (!el) return false;
    if (DEEP_SCAN_SKIP_TAGS.includes(tagOf(el))) return false;
    if (isExcluded(el)) return false;
    // Already handled by the cheap path.
    if (attrOf(el, STATE_ATTR) !== null) return false;
    return true;
  }

  /**
   * Is this element really a page backdrop rather than content?
   * Blurring one of these would blur everything sitting on top of it.
   *
   * @param {{width?:number, height?:number}} rect
   * @param {{width?:number, height?:number}} viewport
   * @returns {boolean}
   */
  function isPageBackground(rect, viewport) {
    if (!rect || !viewport) return false;
    const vw = Number(viewport.width) || 0;
    const vh = Number(viewport.height) || 0;
    if (vw <= 0 || vh <= 0) return false;
    const w = Number(rect.width) || 0;
    const h = Number(rect.height) || 0;
    return w >= vw * PAGE_BACKGROUND_RATIO && h >= vh * PAGE_BACKGROUND_RATIO;
  }

  /**
   * Explicit opt-outs: our own UI, and anything flagged with the skip attribute.
   * @param {object} el
   * @returns {boolean}
   */
  function isExcluded(el) {
    if (!el) return true;
    if (attrOf(el, SKIP_ATTR) !== null) return true;
    const tag = tagOf(el);
    if (tag === "SVG" || tag === "PATH") return true;
    return false;
  }

  /**
   * Too small to be worth blurring? Zero-sized elements are *not* skipped:
   * lazy-loaded images measure 0x0 before layout, and skipping them would
   * leave the most common case on a feed unblurred.
   *
   * @param {{width?:number, height?:number}} rect
   * @param {number} [minPx]
   * @returns {boolean}
   */
  function isTooSmall(rect, minPx) {
    const limit = typeof minPx === "number" ? minPx : MIN_MEDIA_PX;
    if (!rect) return false;
    const w = Number(rect.width) || 0;
    const h = Number(rect.height) || 0;
    if (w === 0 && h === 0) return false;
    return w < limit && h < limit;
  }

  /**
   * The full decision for one element, given its measured box.
   *
   * @param {object} el
   * @param {{width?:number, height?:number}} [rect]
   * @returns {boolean} true when the element should be blurred
   */
  function shouldBlurElement(el, rect) {
    if (!isMediaElement(el)) return false;
    if (isExcluded(el)) return false;
    if (isTooSmall(rect)) return false;
    return true;
  }

  /**
   * Which state an element should end up in, given the page-level settings.
   * Centralising this is what makes toggling off and back on reliable: the
   * old build short-circuited on an "already handled" flag and never restored
   * the blur.
   *
   * @param {object} opts
   * @param {boolean} opts.active   blur is on for this page
   * @param {boolean} opts.revealed the user already revealed this element
   * @param {boolean} opts.keepRevealed "keep media unblurred" is on
   * @param {boolean} opts.lockBlur "never unblur" is on
   * @returns {"blurred"|"revealed"|"off"}
   */
  function nextState(opts) {
    const o = opts || {};
    if (!o.active) return STATE.OFF;
    if (o.lockBlur) return STATE.BLURRED;
    if (o.revealed && o.keepRevealed) return STATE.REVEALED;
    return STATE.BLURRED;
  }

  return {
    BG_ATTR,
    DEEP_SCAN_BATCH,
    DEEP_SCAN_SKIP_TAGS,
    MEDIA_SELECTOR,
    MEDIA_TAGS,
    MIN_MEDIA_PX,
    PAGE_BACKGROUND_RATIO,
    SKIP_ATTR,
    STATE,
    STATE_ATTR,
    hasBackgroundImage,
    hasComputedBackgroundImage,
    isDeepScanCandidate,
    isPageBackground,
    isExcluded,
    isMediaElement,
    isTooSmall,
    nextState,
    shouldBlurElement,
  };
});
