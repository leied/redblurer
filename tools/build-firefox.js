#!/usr/bin/env node
/**
 * tools/build-firefox.js — produce a loadable Firefox copy of the extension.
 *
 * Chrome loads src/ directly and always will; this is the one place a build
 * step exists, and only because the two browsers disagree about the manifest.
 * Everything else is copied across byte for byte.
 *
 *   npm run build:firefox   →   dist/firefox/
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { toFirefoxManifest } = require("./firefox-manifest.js");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "dist", "firefox");

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else fs.copyFileSync(source, target);
  }
}

function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  copyDir(SRC, OUT);

  const chromeManifest = JSON.parse(
    fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"),
  );
  fs.writeFileSync(
    path.join(OUT, "manifest.json"),
    JSON.stringify(toFirefoxManifest(chromeManifest), null, 2) + "\n",
  );

  const relative = path.relative(ROOT, OUT);
  process.stdout.write(
    `Firefox build written to ${relative}\n` +
      "Load it with about:debugging → This Firefox → Load Temporary Add-on,\n" +
      `then pick ${path.join(relative, "manifest.json")}\n`,
  );
}

build();
