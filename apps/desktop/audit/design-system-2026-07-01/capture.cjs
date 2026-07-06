const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const auditDir = __dirname;
const appUrl = process.env.HERMES_AUDIT_URL || 'http://127.0.0.1:5173/';
const referencePath = '/Users/koyunseo/Downloads/hermes-os-desktop-app 3/project/Hermes Tasks.dc.html';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeWindow() {
  const win = new BrowserWindow({
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
  return win;
}

async function snap(win, name) {
  await wait(350);
  const image = await win.capturePage();
  await fs.writeFile(path.join(auditDir, name), image.toPNG());
}

async function clickText(win, selector, label) {
  await win.webContents.executeJavaScript(`
    (() => {
      const clean = (node) => (node.textContent || '').replace(/\\s+/g, ' ').trim();
      const target = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((node) => clean(node).includes(${JSON.stringify(label)}));
      if (!target) throw new Error('missing ${selector} ${label}');
      target.click();
    })()
  `);
}

async function metrics(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      const rect = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const box = el.getBoundingClientRect();
        return { width: Math.round(box.width), height: Math.round(box.height), x: Math.round(box.x), y: Math.round(box.y) };
      };
      const css = (selector, prop) => {
        const el = document.querySelector(selector);
        return el ? getComputedStyle(el).getPropertyValue(prop).trim() : null;
      };
      return {
        title: document.title,
        sidebar: rect('.sidebar'),
        topbar: rect('.topbar'),
        chat: rect('.chat'),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        rootFont: getComputedStyle(document.body).fontFamily,
        accent: css('.app-root', '--accent'),
        navLabels: Array.from(document.querySelectorAll('.nav-item')).slice(0, 30).map((el) => el.textContent.replace(/\\s+/g, ' ').trim()),
      };
    })()
  `);
}

async function serveReference() {
  const referenceHtml = await fs.readFile(referencePath, 'utf8');
  const supportPath = path.join(path.dirname(referencePath), 'support.js');
  const supportJs = await fs.readFile(supportPath, 'utf8').catch(() => '');
  const server = http.createServer((request, response) => {
    if (request.url === '/support.js') {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      response.end(supportJs);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(referenceHtml);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function main() {
  await fs.mkdir(auditDir, { recursive: true });
  await app.whenReady();

  const current = await makeWindow();
  await current.loadURL(appUrl);
  await wait(1800);
  const initialMetrics = await metrics(current);
  await snap(current, '01-current-calendar.png');

  await clickText(current, 'button.nav-item', '위키');
  await wait(1800);
  const wikiMetrics = await current.webContents.executeJavaScript(`
    (() => ({
      graphNodes: document.querySelectorAll('.wiki-node').length,
      graphEdges: document.querySelectorAll('.wiki-edge').length,
      hasReader: !!document.querySelector('.wiki-reader'),
      graphPanel: !!document.querySelector('.wiki-graph-panel'),
      graphBg: getComputedStyle(document.querySelector('.wiki-graph-canvas')).backgroundColor,
    }))()
  `);
  await snap(current, '02-current-wiki-graph.png');

  await clickText(current, 'button.primary', '새 작업');
  await wait(500);
  const modalMetrics = await current.webContents.executeJavaScript(`
    (() => ({
      hasPopover: !!document.querySelector('.new-task-popover'),
      popover: (() => {
        const el = document.querySelector('.new-task-popover');
        if (!el) return null;
        const box = el.getBoundingClientRect();
        return { width: Math.round(box.width), height: Math.round(box.height), x: Math.round(box.x), y: Math.round(box.y) };
      })(),
    }))()
  `);
  await snap(current, '03-current-new-task-modal.png');

  const reference = await makeWindow();
  const referenceServer = await serveReference();
  await reference.loadURL(referenceServer.url);
  await wait(1800);
  await snap(reference, '04-reference-original-html.png');
  const referenceMetrics = await reference.webContents.executeJavaScript(`
    (() => ({
      bodyText: document.body.textContent.replace(/\\s+/g, ' ').trim().slice(0, 500),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      rootFont: getComputedStyle(document.body).fontFamily,
    }))()
  `);
  reference.destroy();
  referenceServer.server.close();

  current.destroy();
  await fs.writeFile(path.join(auditDir, 'metrics.json'), JSON.stringify({ initialMetrics, wikiMetrics, modalMetrics, referenceMetrics }, null, 2));
  console.log(JSON.stringify({ initialMetrics, wikiMetrics, modalMetrics, referenceMetrics }, null, 2));
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.quit();
  process.exit(1);
});
