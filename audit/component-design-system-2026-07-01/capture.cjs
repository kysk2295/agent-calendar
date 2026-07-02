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

async function snap(win, name) {
  await wait(400);
  const image = await win.capturePage();
  await fs.writeFile(path.join(auditDir, name), image.toPNG());
}

async function run(win, js) {
  return win.webContents.executeJavaScript(js);
}

async function click(win, selector, contains = '') {
  await run(win, `
    (() => {
      const text = (node) => (node.textContent || '').replace(/\\s+/g, ' ').trim();
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const target = ${JSON.stringify(contains)} ? nodes.find((node) => text(node).includes(${JSON.stringify(contains)})) : nodes[0];
      if (!target) throw new Error('missing ${selector} ${contains}');
      target.click();
    })()
  `);
  await wait(250);
}

async function collect(win, label) {
  return run(win, `
    (() => {
      const pick = (selector, index = 0) => {
        const el = document.querySelectorAll(selector)[index];
        if (!el) return null;
        const css = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          selector,
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          color: css.color,
          background: css.backgroundColor,
          border: css.border,
          radius: css.borderRadius,
          fontSize: css.fontSize,
          fontWeight: css.fontWeight,
          boxShadow: css.boxShadow,
        };
      };
      return {
        label: ${JSON.stringify(label)},
        popover: pick('.new-task-popover'),
        dateChip: pick('.new-date-chip'),
        newTitle: pick('.new-task-title-row input'),
        cancel: pick('.new-task-footer > button:not(.new-list-button):not(.primary)'),
        confirm: pick('.new-task-footer > .primary'),
        listButton: pick('.new-list-button'),
        segment: pick('.new-segment button[data-active="true"]'),
        quickDate: pick('.new-quick-dates button'),
        pickerNav: pick('.picker-head button'),
        pickerDay: pick('.picker-grid button[data-active="true"]'),
        accordion: pick('.new-accordion-row'),
        detailFooterButton: pick('.detail-footer button'),
        detailPrimary: pick('.detail-footer .primary'),
        delegateCancel: pick('.delegate-modal footer button'),
        agentCancel: pick('.agent-modal footer button'),
        settingsDone: pick('.settings-overlay footer .primary'),
        accountLogout: pick('.account-box button:not(.primary)'),
      };
    })()
  `);
}

async function main() {
  await fs.mkdir(auditDir, { recursive: true });
  await app.whenReady();
  const win = await makeWindow();
  await win.loadURL(appUrl);
  await wait(1800);

  const results = [];
  await click(win, '.topbar .primary', '새 작업');
  results.push(await collect(win, 'new-task-focused-title'));
  await snap(win, '00-new-task-focused-title.png');
  await click(win, '.new-date-chip');
  results.push(await collect(win, 'new-task-date-picker'));
  await snap(win, '01-new-task-date-picker.png');

  await click(win, '.new-segment button', '지속 시간');
  results.push(await collect(win, 'new-task-duration-picker'));
  await snap(win, '02-new-task-duration-picker.png');

  await click(win, '.new-task-footer > button', '취소');
  await click(win, 'button.nav-item', '기본함');
  await click(win, '.row.task-row');
  results.push(await collect(win, 'task-detail-modal'));
  await snap(win, '03-task-detail-modal.png');

  await click(win, '.detail-footer button', '에이전트에 위임');
  results.push(await collect(win, 'delegate-modal'));
  await snap(win, '04-delegate-modal.png');
  await click(win, '.delegate-modal footer button', '취소');

  await click(win, '.profile');
  results.push(await collect(win, 'settings-overlay'));
  await snap(win, '05-settings-overlay.png');

  await fs.writeFile(path.join(auditDir, 'component-metrics.json'), JSON.stringify(results, null, 2));
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
