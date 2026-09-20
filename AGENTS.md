# AGENTS.md

## Project overview

RedBlurer is a Manifest V3 browser extension that blurs media on web pages. Chrome loads `src/` directly; there is no Chrome build step.

## Repository map

- `src/shared/`: pure configuration and media-classification logic shared across extension contexts.
- `src/content/`: page scanning, blur state, hover behavior, and injected CSS.
- `src/background.js`: install migration, toolbar badge state, and keyboard commands.
- `src/popup/` and `src/options/`: extension settings UIs.
- `test/`: Node unit and jsdom integration tests.
- `tools/dom-harness.js`: jsdom Chrome API harness used by UI/content tests.
- `tools/build-firefox.js`: creates the Firefox package and generated manifest.

## Development commands

- Install dependencies: `npm install`
- Run the full test suite: `npm test`
- Build the Firefox package: `npm run build:firefox`
- Manually test Chrome: load the `src/` directory as an unpacked extension from `chrome://extensions/`.

## Change guidelines

- Keep `src/shared/` free of live DOM and Chrome APIs so it remains directly testable in Node.
- Preserve the content-script load order in `src/manifest.json`: config and media helpers must load before `content/content.js`.
- Content scripts run in an isolated world. Use DOM events or extension APIs for page interaction; patching page prototypes does not cross that boundary.
- Media outside RedBlurer's scope must have extension-owned attributes removed. Do not force `filter: none`, because that overrides site styling.
- Apply blur immediately. Only reveal transitions may animate, to avoid briefly exposing protected media.
- Avoid restyling media parents; doing so can break site flex/grid layouts.
- Treat modern feeds as dynamic: support late nodes, overlays, iframes, and open shadow roots without scanning the whole document on every pointer event.
- If configuration keys change, update normalization/migration logic and both settings surfaces together.
- Keep `package.json` and `src/manifest.json` versions synchronized.

## Testing expectations

- Add regression coverage for behavior changes. Prefer pure tests for shared logic and `tools/dom-harness.js` for content/UI behavior.
- Run `npm test` before handing off a change.
- When changing extension wiring, also verify referenced manifest files, declared commands, and UI element IDs; `test/extension.test.js` enforces these contracts.
- For site-specific DOM bugs, use a minimal representative fixture instead of depending on a live network page.
