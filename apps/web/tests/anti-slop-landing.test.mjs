import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appRoot = new URL("../app/", import.meta.url);
const pageSource = await readFile(new URL("page.tsx", appRoot), "utf8");
const layoutSource = await readFile(new URL("layout.tsx", appRoot), "utf8");
const css = await readFile(new URL("globals.css", appRoot), "utf8");

test("landing uses actual product surfaces instead of a fabricated calendar demo", () => {
  for (const image of ["product-calendar.png", "product-agents.png", "product-wiki.png"]) {
    assert.match(pageSource, new RegExp(`src=\"/${image.replace(".", "\\.")}\"`));
  }
  assert.doesNotMatch(pageSource, /function WeekBoard|const schedule|calendar-scene|week-board/);
  assert.doesNotMatch(pageSource, /row-number|section-label|status-dot/);
  assert.doesNotMatch(pageSource, /[—–]/);
});

test("hero and page structure follow the restrained asymmetric product contract", () => {
  assert.match(pageSource, /className="hero-copy-column"/);
  assert.match(pageSource, /className="hero-product"/);
  assert.match(css, /\.hero\s*\{[^}]*grid-template-columns:/s);
  assert.match(css, /\.hero\s*\{[^}]*min-height:\s*calc\(100dvh/s);
  assert.match(css, /\.site-header\s*\{[^}]*height:\s*(?:6[0-9]|7[0-2])px/s);
  assert.equal((pageSource.match(/label=\{handoff\.signup\.label\}/g) || []).length, 1);
  assert.doesNotMatch(pageSource, /제품 살펴보기.*[↓⇣]|Private beta.*Private beta/s);
});

test("landing supports one consistent light and dark token system with reduced motion", () => {
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /\.runner-section\s*\{[^}]*background:\s*var\(--dark\)/s);
  assert.doesNotMatch(css, /\.closing\s*\{[^}]*background:\s*var\(--accent\)/s);
  assert.doesNotMatch(layoutSource, /[—–]/);
});
