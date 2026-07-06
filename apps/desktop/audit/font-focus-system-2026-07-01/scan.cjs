const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const auditDir = __dirname;
const appUrl = process.env.HERMES_AUDIT_URL || 'http://127.0.0.1:5173/';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeWindow() {
  return new BrowserWindow({
    width: 1320,
    height: 824,
    show: false,
    backgroundColor: '#EAE5DA',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

async function js(win, code) {
  return win.webContents.executeJavaScript(code);
}

async function click(win, selector, contains = '') {
  await js(win, `
    (() => {
      const clean = (node) => (node.textContent || '').replace(/\\s+/g, ' ').trim();
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const target = ${JSON.stringify(contains)} ? nodes.find((node) => clean(node).includes(${JSON.stringify(contains)})) : nodes[0];
      if (!target) throw new Error('missing ${selector} ${contains}');
      target.click();
    })()
  `);
  await wait(300);
}

async function optionalClick(win, selector, contains = '') {
  const clicked = await js(win, `
    (() => {
      const clean = (node) => (node.textContent || '').replace(/\\s+/g, ' ').trim();
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const target = ${JSON.stringify(contains)} ? nodes.find((node) => clean(node).includes(${JSON.stringify(contains)})) : nodes[0];
      if (!target) return false;
      target.click();
      return true;
    })()
  `);
  if (clicked) await wait(300);
  return clicked;
}

async function snap(win, name) {
  await wait(250);
  const image = await win.capturePage();
  await fs.writeFile(path.join(auditDir, name), image.toPNG());
}

async function scan(win, label) {
  return js(win, `
    (async () => {
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const css = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && css.visibility !== 'hidden' && css.display !== 'none';
      };
      const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const styleOf = (el) => {
        const css = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          selector: el.className ? '.' + String(el.className).trim().replace(/\\s+/g, '.') : el.tagName.toLowerCase(),
          text: clean(el.value || el.placeholder || el.textContent).slice(0, 80),
          className: String(el.className || ''),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          fontFamily: css.fontFamily,
          fontSize: css.fontSize,
          fontWeight: css.fontWeight,
          letterSpacing: css.letterSpacing,
          color: css.color,
          background: css.backgroundColor,
          border: css.border,
          borderColor: css.borderColor,
          borderRadius: css.borderRadius,
          boxShadow: css.boxShadow,
          appearance: css.appearance,
        };
      };
      const controls = Array.from(document.querySelectorAll('input, textarea, select, button')).filter(isVisible);
      const samples = [];
      const issues = [];
      for (const el of controls) {
        const before = styleOf(el);
        let after = before;
        if (['input', 'textarea', 'select'].includes(el.tagName.toLowerCase())) {
          el.focus();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          after = styleOf(el);
          if (after.boxShadow && after.boxShadow !== 'none') {
            issues.push({ type: 'focus-shadow-leak', label: ${JSON.stringify(label)}, before, after });
          }
        }
        if (el.tagName.toLowerCase() === 'button') {
          const defaultishBorder = !/0px none/i.test(before.border) && /outset|buttonface|rgb\\(0, 0, 0\\)|rgb\\(118, 118, 118\\)/i.test(before.border);
          const defaultishBackground = /rgb\\(239, 239, 239\\)|buttonface/i.test(before.background);
          if (defaultishBorder || defaultishBackground) {
            issues.push({ type: 'native-button-leak', label: ${JSON.stringify(label)}, before });
          }
        }
        if (!before.fontFamily.includes('Pretendard')) {
          issues.push({ type: 'font-family-leak', label: ${JSON.stringify(label)}, before });
        }
        samples.push({ before, after });
      }
      return { label: ${JSON.stringify(label)}, count: controls.length, issues, samples };
    })()
  `);
}

async function main() {
  await fs.mkdir(auditDir, { recursive: true });
  await app.whenReady();
  const win = await makeWindow();
  const scans = [];
  const skipped = [];

  await win.loadURL(appUrl);
  await wait(1800);
  scans.push(await scan(win, 'calendar'));

  await click(win, '.topbar .primary', '새 작업');
  scans.push(await scan(win, 'new-task-focused'));
  await snap(win, '01-new-task-focused.png');
  await click(win, '.new-task-footer > button', '취소');

  for (const nav of ['오늘', '다음 7일', '기본함', '메일함', '칸반 보드', '생각노트', '주간 회고', '위키', '일기', '에이전트']) {
    if (!(await optionalClick(win, 'button.nav-item', nav))) {
      skipped.push(nav);
      continue;
    }
    scans.push(await scan(win, nav));
    if (nav === '기본함') {
      if (!(await optionalClick(win, '.row.task-row'))) {
        skipped.push('task-detail');
        continue;
      }
      scans.push(await scan(win, 'task-detail'));
      await snap(win, '02-task-detail.png');
      if (await optionalClick(win, '.detail-footer button', '에이전트에 위임')) {
        scans.push(await scan(win, 'delegate-modal'));
        await snap(win, '03-delegate-modal.png');
        await optionalClick(win, '.delegate-modal footer button', '취소');
      } else {
        skipped.push('delegate-modal');
      }
      await optionalClick(win, '.detail-close');
    }
  }

  await click(win, '.sidebar-search');
  scans.push(await scan(win, 'search-screen'));

  await click(win, '.profile');
  scans.push(await scan(win, 'settings-overlay'));
  await snap(win, '04-settings-overlay.png');
  await click(win, '.settings-overlay header button');

  await click(win, '.topbar .icon-button');
  scans.push(await scan(win, 'chat-drawer'));
  await snap(win, '05-chat-drawer.png');

  const issues = scans.flatMap((entry) => entry.issues);
  await fs.writeFile(path.join(auditDir, 'scan-results.json'), JSON.stringify({ scans, skipped, issueCount: issues.length, issues }, null, 2));
  console.log(JSON.stringify({ screens: scans.length, skipped, issueCount: issues.length, issues: issues.slice(0, 20) }, null, 2));
  win.destroy();
  app.quit();
}

main().catch(async (error) => {
  await fs.mkdir(auditDir, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(auditDir, 'error.txt'), error.stack || String(error)).catch(() => {});
  console.error(error);
  app.quit();
  process.exit(1);
});
