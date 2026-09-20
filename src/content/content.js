/**
 * content/content.js — applies and maintains the blur on a page.
 *
 * Runs at document_start in every http(s) frame. Depends on shared/config.js
 * and shared/media.js, which the manifest loads first into the same isolated
 * world.
 *
 * Three things here are deliberate and worth knowing before editing:
 *
 *  1. Element state lives in a data attribute, not a "handled" flag. The
 *     previous build marked each element done once and short-circuited, so
 *     switching the extension off and on again left every image visible.
 *     Re-deriving the state every time makes that impossible.
 *
 *  2. Autoplay is stopped with a capturing `play` listener, not by patching
 *     HTMLVideoElement.prototype. Content scripts run in an isolated world,
 *     so a prototype patch here is invisible to the page's own scripts. DOM
 *     events cross the boundary; prototypes do not.
 *
 *  3. Hover is hit-tested from pointer coordinates rather than left to CSS
 *     :hover. Feeds stack transparent overlays over their images, which eat
 *     :hover on the element underneath.
 */
(function () {
  "use strict";

  const Config = globalThis.RedBlurerConfig;
  const Media = globalThis.RedBlurerMedia;
  if (!Config || !Media) return;

  const { STATE, STATE_ATTR, MEDIA_SELECTOR } = Media;
  const HOVER_ATTR = "data-redblurer-hover";
  const BOOT_CLASS = "redblurer-boot";
  const LOCKED_CLASS = "redblurer-locked";

  /**
   * Mirrors the reveal rules from content.css. Shadow roots do not inherit
   * document stylesheets, so anything rendered inside a web component needs
   * its own copy. Custom properties *do* pierce the boundary, so the radius
   * set on <html> still applies here.
   */
  const SHADOW_CSS = `
    [${STATE_ATTR}="${STATE.BLURRED}"] {
      filter: blur(var(--redblurer-radius, 18px)) !important;
      cursor: pointer !important;
    }
    [${STATE_ATTR}="${STATE.BLURRED}"][${HOVER_ATTR}],
    [${STATE_ATTR}="${STATE.BLURRED}"]:hover {
      filter: blur(0) !important;
      transition: filter var(--redblurer-duration, 200ms)
        var(--redblurer-ease, cubic-bezier(0.2, 0, 0, 1)) !important;
    }
    [${STATE_ATTR}="${STATE.REVEALED}"] {
      transition: filter var(--redblurer-duration, 200ms)
        var(--redblurer-ease, cubic-bezier(0.2, 0, 0, 1)) !important;
    }
    :host-context(html.${LOCKED_CLASS}) [${STATE_ATTR}="${STATE.BLURRED}"] {
      filter: blur(var(--redblurer-radius, 18px)) !important;
      cursor: default !important;
      transition: none !important;
    }
  `;

  const root = document.documentElement;

  let config = Config.normalizeConfig(null);
  let active = false;
  let settingsLoaded = false;

  /** Elements the user has revealed, for "keep media unblurred". */
  const revealed = new WeakSet();
  /** Shadow roots we have already styled and observed. */
  const knownRoots = new WeakSet();
  /** Elements queued for a state refresh on the next frame. */
  const queue = new Set();

  let flushHandle = 0;
  let fullScanQueued = false;
  let hoverEl = null;
  let pointerX = -1;
  let pointerY = -1;
  let hoverHandle = 0;

  // ── Boot guard ────────────────────────────────────────────────────────────
  // Settings arrive asynchronously. Cover everything until they do.
  if (root) root.classList.add(BOOT_CLASS);

  // ── Document-level flags ──────────────────────────────────────────────────

  function applyDocumentFlags() {
    if (!root) return;
    root.style.setProperty("--redblurer-radius", config.blurRadius + "px");
    root.classList.toggle(LOCKED_CLASS, active && config.lockBlur);
    if (settingsLoaded) root.classList.remove(BOOT_CLASS);
  }

  // ── Per-element state ─────────────────────────────────────────────────────

  function measure(el) {
    if (typeof el.getBoundingClientRect !== "function") return null;
    try {
      return el.getBoundingClientRect();
    } catch {
      return null;
    }
  }

  /**
   * Bring one element in line with the current settings. Safe to call
   * repeatedly; it only touches the DOM when the state actually changes.
   */
  function applyState(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    applyStateWithRect(el, measure(el));
  }

  /**
   * Apply a batch, measuring everything before writing anything.
   * Interleaving reads and writes here would force a layout per element,
   * which is ruinous on a feed that adds media by the hundred.
   */
  function applyStateBatch(elements) {
    const measured = [];
    for (const el of elements) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) continue;
      measured.push([el, measure(el)]);
    }
    for (const [el, rect] of measured) applyStateWithRect(el, rect);
  }

  /** Leave an element exactly as the page styled it. */
  function clearState(el) {
    if (el.hasAttribute(STATE_ATTR)) el.removeAttribute(STATE_ATTR);
    if (el.hasAttribute(HOVER_ATTR)) el.removeAttribute(HOVER_ATTR);
  }

  function applyStateWithRect(el, rect) {
    if (!Media.shouldBlurElement(el, rect)) {
      clearState(el);
      return;
    }

    const next = Media.nextState({
      active,
      revealed: revealed.has(el),
      keepRevealed: config.keepRevealed,
      lockBlur: config.lockBlur,
    });

    // Nothing to do here means leaving no trace. Marking the element with an
    // "off" state and forcing filter: none would override whatever filter the
    // site applies to its own images.
    if (next === STATE.OFF) {
      clearState(el);
      return;
    }

    if (el.getAttribute(STATE_ATTR) !== next) el.setAttribute(STATE_ATTR, next);
    if (next !== STATE.BLURRED && el.hasAttribute(HOVER_ATTR)) {
      el.removeAttribute(HOVER_ATTR);
    }
    if (next === STATE.BLURRED) holdVideo(el);
  }

  /** Stop a blurred video from running, and keep it from restarting itself. */
  function holdVideo(el) {
    if (el.tagName !== "VIDEO") return;
    try {
      el.autoplay = false;
      el.removeAttribute("autoplay");
      if (!el.paused) el.pause();
    } catch {
      /* cross-origin or detached media, nothing we can do */
    }
  }

  // ── Scanning ──────────────────────────────────────────────────────────────

  function enqueue(el) {
    queue.add(el);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushHandle) return;
    flushHandle = requestAnimationFrame(flush);
  }

  /**
   * Apply every queued change in one frame. Batching matters: a busy feed can
   * fire hundreds of mutations per second, and measuring elements one at a
   * time as they arrive would thrash layout.
   */
  function flush() {
    flushHandle = 0;

    if (fullScanQueued) {
      fullScanQueued = false;
      queue.clear();
      applyDocumentFlags();
      for (const scope of collectRoots(document)) {
        adoptShadowStyles(scope);
        applyStateBatch(scope.querySelectorAll(MEDIA_SELECTOR));
      }
      refreshHover();
      return;
    }

    const batch = Array.from(queue);
    queue.clear();
    applyStateBatch(batch);
    refreshHover();
  }

  function scheduleFullScan() {
    fullScanQueued = true;
    scheduleFlush();
  }

  /**
   * The document plus every open shadow root reachable from `node`.
   * Closed roots are invisible to extensions; nothing to be done about those.
   */
  function collectRoots(node) {
    const roots = [];
    const stack = [node];

    while (stack.length) {
      const scope = stack.pop();
      if (!scope || typeof scope.querySelectorAll !== "function") continue;
      roots.push(scope);

      let hosts;
      try {
        hosts = scope.querySelectorAll("*");
      } catch {
        continue;
      }
      for (const el of hosts) {
        if (el.shadowRoot) stack.push(el.shadowRoot);
      }
    }
    return roots;
  }

  /** Give a shadow root its own copy of the blur rules, once. */
  function adoptShadowStyles(scope) {
    if (!scope || scope.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (knownRoots.has(scope)) return;
    knownRoots.add(scope);

    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(SHADOW_CSS);
      scope.adoptedStyleSheets = [...scope.adoptedStyleSheets, sheet];
    } catch {
      const style = document.createElement("style");
      style.textContent = SHADOW_CSS;
      scope.appendChild(style);
    }

    observer.observe(scope, OBSERVE_OPTIONS);
  }

  // ── Watching the page ─────────────────────────────────────────────────────

  const OBSERVE_OPTIONS = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "style", "poster", "autoplay"],
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        enqueue(mutation.target);
        continue;
      }

      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        if (node.matches && node.matches(MEDIA_SELECTOR)) enqueue(node);
        if (node.querySelectorAll) {
          node.querySelectorAll(MEDIA_SELECTOR).forEach(enqueue);
        }

        // New subtrees can bring new web components with them.
        if (node.shadowRoot || (node.querySelector && node.querySelector("*"))) {
          for (const scope of collectRoots(node)) {
            if (scope === node) continue;
            adoptShadowStyles(scope);
            scope.querySelectorAll(MEDIA_SELECTOR).forEach(enqueue);
          }
        }
      }
    }
  });

  // Catch the page's own play() calls. This listener sees them because it is
  // a DOM event; the isolated world shares the DOM even though it does not
  // share the JavaScript heap.
  function onPlay(event) {
    const el = event.target;
    if (!el || el.tagName !== "VIDEO") return;
    if (el.getAttribute(STATE_ATTR) !== STATE.BLURRED) return;
    // Hovering a blurred video is an explicit request to see it, unless the
    // user has locked the blur.
    if (!config.lockBlur && el.hasAttribute(HOVER_ATTR)) return;
    holdVideo(el);
  }

  // ── Hover ─────────────────────────────────────────────────────────────────

  /**
   * The blurred element under the cursor, piercing open shadow roots.
   * Returns null when the cursor is over something we do not manage.
   */
  function mediaAtPoint(x, y) {
    let scope = document;

    for (let depth = 0; depth < 16; depth += 1) {
      if (!scope || typeof scope.elementsFromPoint !== "function") return null;

      let stack;
      try {
        stack = scope.elementsFromPoint(x, y);
      } catch {
        return null;
      }
      if (!stack || !stack.length) return null;

      for (const el of stack) {
        if (el.hasAttribute && el.hasAttribute(STATE_ATTR)) return el;
      }

      const host = stack.find((el) => el.shadowRoot);
      if (!host) return null;
      scope = host.shadowRoot;
    }
    return null;
  }

  function setHover(el) {
    if (hoverEl === el) return;

    if (hoverEl && hoverEl.removeAttribute) hoverEl.removeAttribute(HOVER_ATTR);
    hoverEl = el;
    if (!el) return;

    el.setAttribute(HOVER_ATTR, "");

    // "Keep media unblurred": the first reveal is permanent for this page.
    if (config.keepRevealed && !revealed.has(el)) {
      revealed.add(el);
      applyState(el);
    }
  }

  /** Re-evaluate what the cursor is over, using the last known coordinates. */
  function refreshHover() {
    if (!active || config.lockBlur || pointerX < 0) {
      setHover(null);
      return;
    }
    const el = mediaAtPoint(pointerX, pointerY);
    setHover(el && el.getAttribute(STATE_ATTR) === STATE.BLURRED ? el : null);
  }

  function scheduleHover() {
    if (hoverHandle) return;
    hoverHandle = requestAnimationFrame(() => {
      hoverHandle = 0;
      refreshHover();
    });
  }

  function onPointerMove(event) {
    pointerX = event.clientX;
    pointerY = event.clientY;
    scheduleHover();
  }

  function onPointerLeave() {
    pointerX = -1;
    pointerY = -1;
    setHover(null);
  }

  // Content scrolling under a stationary cursor changes what is underneath it.
  function onScroll() {
    if (pointerX >= 0) scheduleHover();
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  /**
   * The URL that decides scope for this frame.
   *
   * An about:blank or srcdoc frame has no host of its own, but it inherits
   * its parent's origin and is same-origin with it, so the nearest readable
   * ancestor is the honest answer. Without this, media inside those frames
   * would never be matched against the domain list.
   */
  function effectiveUrl() {
    if (/^https?:/i.test(location.href)) return location.href;
    try {
      let frame = window;
      for (let depth = 0; depth < 10 && frame !== frame.parent; depth += 1) {
        frame = frame.parent;
        if (/^https?:/i.test(frame.location.href)) return frame.location.href;
      }
    } catch {
      /* a cross-origin ancestor, which we are not entitled to read */
    }
    return location.href;
  }

  function adopt(nextConfig) {
    config = Config.normalizeConfig(nextConfig);
    active = Config.shouldBlurUrl(effectiveUrl(), config);
    settingsLoaded = true;
    scheduleFullScan();
  }

  function loadSettings() {
    try {
      chrome.storage.sync.get(null, (stored) => {
        if (chrome.runtime.lastError) {
          // Storage unavailable; fall back to defaults rather than leaving
          // the page stuck behind the boot blur.
          adopt(null);
          return;
        }
        adopt(stored);
      });
    } catch {
      adopt(null);
    }
  }

  function watchSettings() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") return;
        const next = { ...config };
        for (const [key, change] of Object.entries(changes)) {
          next[key] = change.newValue;
        }
        adopt(next);
      });
    } catch {
      /* extension context torn down, e.g. after a reload during development */
    }
  }

  // ── Start ─────────────────────────────────────────────────────────────────

  observer.observe(root, OBSERVE_OPTIONS);
  document.addEventListener("play", onPlay, true);
  document.addEventListener("pointermove", onPointerMove, { passive: true, capture: true });
  document.addEventListener("pointerleave", onPointerLeave, { passive: true, capture: true });
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  window.addEventListener("blur", onPointerLeave, { passive: true });

  // Late arrivals: images parsed after document_start, and anything the page
  // only paints once it is fully loaded.
  document.addEventListener("DOMContentLoaded", scheduleFullScan, { once: true });
  window.addEventListener("load", scheduleFullScan, { once: true });

  loadSettings();
  watchSettings();
})();
