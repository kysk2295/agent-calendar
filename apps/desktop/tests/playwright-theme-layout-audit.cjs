const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const evidenceDir = process.env.EVIDENCE_DIR || '';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date());
const themes = ['Terracotta', 'Warm', 'Dark', 'Sage', 'Mono'];
const navLabels = ['오늘', '캘린더', '다음 7일', '기본함', '메일함', '칸반 보드', '주간 회고', '위키', '일기', '에이전트', '위젯'];

async function captureEvidence(page, name) {
  if (!evidenceDir) return;
  await fs.mkdir(evidenceDir, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceDir, `${name}.png`),
    fullPage: true,
  });
}

async function assertConsoleButtonOutsideContent(page, label) {
  const [button, content] = await Promise.all([
    page.locator('.chat-fab').boundingBox(),
    page.locator('.content').boundingBox(),
  ]);
  assert.ok(button && content, `${label}: Console button and content must be visible`);
  assert.ok(
    button.y + button.height <= content.y + 1,
    `${label}: Console button overlaps content ${JSON.stringify({ button, content })}`,
  );
}

function routeApi(page) {
  return page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (request.method() === 'GET' && path === '/api/state') {
      await route.fulfill({ json: {
        ok: true,
        tasks: [{ id: 'task-a', title: '테마 점검 작업', date: today, time: '09:00', owner: 'Me', status: 'Planned', project: '기본함', category: '기본함' }],
        events: [{ id: 'event-a', title: '테마 점검 일정', date: today, startDate: today, time: '10:00', owner: 'Me', status: 'Planned', kind: 'calendar-event' }],
        agents: [{ id: 'default', name: 'Planner', role: '일정 정리', status: 'idle', emoji: 'P' }],
        runs: [{ id: 'run-a', title: 'UI 점검', agent: 'Planner', status: 'done', step: '완료' }],
        documents: [{ id: 'doc-a', title: '일기 · 오늘', kind: 'diary', date: today, body: '😊 테마 점검 일기' }],
        chatMessages: [],
      } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/tasks') {
      await route.fulfill({ json: { ok: true, tasks: [{ id: 'task-a', title: '테마 점검 작업', date: today, time: '09:00', owner: 'Me', status: 'Planned', project: '기본함', category: '기본함' }] } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/calendar/events') {
      await route.fulfill({ json: { ok: true, events: [{ id: 'event-a', title: '테마 점검 일정', date: today, startDate: today, time: '10:00', owner: 'Me', status: 'Planned', kind: 'calendar-event' }] } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/agents') {
      await route.fulfill({ json: { ok: true, agents: [{ id: 'default', name: 'Planner', role: '일정 정리', status: 'idle', emoji: 'P' }] } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/documents') {
      await route.fulfill({ json: { ok: true, documents: [{ id: 'doc-a', title: '일기 · 오늘', kind: 'diary', date: today, body: '😊 테마 점검 일기' }] } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/wiki') {
      await route.fulfill({ json: { ok: true, wikiIndex: { notes: [] }, notes: [], graph: { nodes: [], edges: [], groups: [] } } });
      return;
    }
    if (path === '/api/settings') {
      await route.fulfill({ json: { ok: true, settings: { uiPreferences: { notify: true, agentShare: true, weekStartMon: true } }, uiPreferences: { notify: true, agentShare: true, weekStartMon: true } } });
      return;
    }
    await route.fulfill({ json: { ok: true, data: {}, items: [], commands: [], jobs: [], messages: [], channels: [], tools: [] } });
  });
}

async function auditVisibleLayout(page, label) {
  const issues = await page.evaluate((context) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01 && rect.width > 0 && rect.height > 0;
    };
    return [...document.querySelectorAll('.settings-overlay, .settings-overlay *, .modal, .modal *, .chat, .chat *')]
      .filter(visible)
      .flatMap((el) => {
        const rect = el.getBoundingClientRect();
        const out = [];
        if (rect.left < -1 || rect.top < -1 || rect.right > viewport.width + 1 || rect.bottom > viewport.height + 1) {
          out.push(`${context}: ${el.className || el.tagName} outside viewport ${JSON.stringify({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })}`);
        }
        const parent = el.closest('.pref-box, .theme-grid, .account-box, .settings-overlay footer, .settings-overlay header');
        if (parent && parent !== el) {
          const box = parent.getBoundingClientRect();
          if (rect.right > box.right + 1 || rect.left < box.left - 1) {
            out.push(`${context}: ${el.className || el.tagName} escapes ${parent.className || parent.tagName}`);
          }
        }
        return out;
      });
  }, label);
  assert.deepEqual(issues, []);
}

async function auditTextContrast(page, label) {
  const issues = await page.evaluate((context) => {
    const parse = (value) => {
      const parts = value.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 1];
      const srgb = value.startsWith('color(srgb');
      return {
        r: srgb ? parts[0] * 255 : parts[0],
        g: srgb ? parts[1] * 255 : parts[1],
        b: srgb ? parts[2] * 255 : parts[2],
        a: parts[3] ?? 1,
      };
    };
    const blend = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const luminance = (rgb) => {
      const channel = (value) => {
        const v = value / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
    };
    const contrast = (fg, bg) => {
      const a = luminance(fg);
      const b = luminance(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01 && rect.width > 0 && rect.height > 0;
    };
    const backgroundFor = (el) => {
      let bg = { r: 255, g: 255, b: 255, a: 1 };
      const chain = [];
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) chain.push(node);
      chain.reverse().forEach((node) => {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color.a > 0) bg = blend(color, bg);
      });
      return bg;
    };
    return [...document.querySelectorAll('.app-root *')]
      .filter(visible)
      .filter((el) => {
        if (el.matches('svg, path, circle, line, rect, img')) return false;
        const ownText = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
        return ownText;
      })
      .flatMap((el) => {
        const text = [...el.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent.trim()).join(' ').trim();
        if (!text || text.length === 1 || /^[✓✕+›▾⌂−]$/.test(text)) return [];
        const style = getComputedStyle(el);
        const ratio = contrast(parse(style.color), backgroundFor(el));
        const min = Number.parseFloat(style.fontSize) >= 18 || Number(style.fontWeight) >= 700 ? 3 : 4.5;
        const identity = el.className || el.getAttribute('aria-label') || el.outerHTML.slice(0, 160);
        return ratio + 0.01 < min ? [`${context}: contrast ${ratio.toFixed(2)} < ${min} for "${text.slice(0, 40)}" (${identity})`] : [];
      })
      .slice(0, 30);
  }, label);
  assert.deepEqual(issues, []);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const narrowPage = await browser.newPage({ viewport: { width: 768, height: 820 } });
  await routeApi(narrowPage);
  await narrowPage.goto(target);
  await narrowPage.waitForSelector('.app-root');
  await assertConsoleButtonOutsideContent(narrowPage, 'narrow-768');
  await narrowPage.locator('.profile').click();
  await narrowPage.waitForSelector('.settings-overlay');
  await auditVisibleLayout(narrowPage, 'settings/narrow-768');
  for (const theme of themes) {
    await narrowPage.getByRole('button', { name: theme }).click();
    await narrowPage.waitForTimeout(80);
    await auditVisibleLayout(narrowPage, `settings/narrow-768/${theme}`);
    await auditTextContrast(narrowPage, `settings/narrow-768/${theme}`);
  }
  await narrowPage.close();

  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await routeApi(page);
  await page.goto(target);
  await page.waitForSelector('.app-root');
  await assertConsoleButtonOutsideContent(page, 'desktop-1280');

  await page.locator('.profile').click();
  await page.waitForSelector('.settings-overlay');
  await auditVisibleLayout(page, 'settings/default');
  await captureEvidence(page, '1280-설정');

  for (const theme of themes) {
    await page.getByRole('button', { name: theme }).click();
    await page.waitForTimeout(80);
    await auditVisibleLayout(page, `settings/${theme}`);
    await auditTextContrast(page, `settings/${theme}`);
  }
  const switches = await page.locator('.pref-box .switch').count();
  for (let index = 0; index < switches; index += 1) {
    await page.locator('.pref-box .switch').nth(index).click();
    await auditVisibleLayout(page, `settings/switch-${index}`);
  }
  await page.getByRole('button', { name: '완료' }).click();

  for (const label of navLabels) {
    await page.locator('.nav-item').filter({ hasText: label }).first().click();
    await page.waitForTimeout(60);
    await auditTextContrast(page, `screen/${label}`);
    await captureEvidence(page, `1280-${label}`);
  }

  await browser.close();
  console.log(JSON.stringify({ ok: true, themes, navLabels }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
