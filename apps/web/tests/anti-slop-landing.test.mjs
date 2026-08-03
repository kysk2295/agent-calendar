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

test("landing explains why the calendar understands, remembers, works, and reports", () => {
  assert.match(pageSource, /id="why"/);
  assert.match(pageSource, /className="why-section"/);
  assert.match(pageSource, /AI를 열 때마다/);
  assert.match(pageSource, /나를 다시 설명하지 않도록/);
  assert.match(pageSource, /사용자가 허용한 일정, 메일, 파일과 기록/);
  assert.match(pageSource, /결과를 다시 캘린더와 Wiki에 남깁니다/);
  assert.match(css, /\.why-section\s*\{[^}]*grid-template-columns:/s);
  assert.doesNotMatch(pageSource, /Calendar-first agent operations/);
});

test("document metadata describes the current calendar product instead of the old control space", () => {
  assert.match(layoutSource, /나를 이해하고 일을 이어가는 캘린더/);
  assert.match(layoutSource, /일정, 메일, 파일과 기록을 이해해/);
  assert.doesNotMatch(layoutSource, /위임한 에이전트 작업|작업 관제 공간/);
});

test("landing supports one consistent light and dark token system with reduced motion", () => {
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /\.runner-section\s*\{[^}]*background:\s*var\(--dark\)/s);
  assert.doesNotMatch(css, /\.closing\s*\{[^}]*background:\s*var\(--accent\)/s);
  assert.doesNotMatch(layoutSource, /[—–]/);
});
