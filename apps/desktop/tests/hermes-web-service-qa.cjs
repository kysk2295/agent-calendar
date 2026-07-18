const { chromium } = require('playwright');

const SCREEN_CHECKS = [
  { id: 'dashboard', label: '대시보드', selector: '.screen-stage--dashboard' },
  { id: 'calendar', label: '캘린더', selector: '.calendar-screen' },
  { id: 'tasks', label: '태스크 보드', selector: '.task-screen' },
  { id: 'workboard', label: '워크보드', selector: '.workboard-screen' },
  { id: 'agents', label: '에이전트', selector: '.agents-dashboard, .agent-settings-screen' },
  { id: 'automation', label: '오토메이션', selector: '.automation-screen' },
];

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redact(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (secret) text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }
  return text
    .replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:token|password|passwd|secret|api[-_]?key|authorization|credential)=)[^&\s]*/gi, '$1[REDACTED]')
    .replace(/((?:authorization|password|secret|api[-_]?key|credential)\s*[:=]\s*)[^,\s]+/gi, '$1[REDACTED]');
}

function targetUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('HERMES_WEB_URL must use http or https');
  }
  // Credentials are supplied to the browser context only, never in the URL.
  parsed.username = '';
  parsed.password = '';
  parsed.hash = `#/dashboard?hermesQa=${Date.now()}`;
  return parsed;
}

function createDiagnostics() {
  return {
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    badResponses: [],
    ignoredExpectedAbortedSse: 0,
  };
}

function isExpectedAbortedSse(request, failure) {
  const errorText = String(failure?.errorText || '');
  if (!/(?:ERR_ABORTED|NS_BINDING_ABORTED|ABORTED|CANCELLED)/i.test(errorText)) return false;
  if (request.method() !== 'GET') return false;
  const pathname = (() => {
    try { return new URL(request.url()).pathname; } catch { return ''; }
  })();
  return request.resourceType() === 'eventsource' || /\/api\/(?:events|sse)(?:\/|$)/i.test(pathname);
}

function shortText(value, secrets) {
  return redact(value, secrets).replace(/\s+/g, ' ').trim().slice(0, 320);
}

function diagnosticsSummary(diagnostics, secrets) {
  const sample = (entries) => entries.slice(0, 8);
  return {
    consoleErrors: { count: diagnostics.consoleErrors.length, sample: sample(diagnostics.consoleErrors).map((entry) => ({ text: shortText(entry.text, secrets), location: redact(entry.location, secrets) })) },
    pageErrors: { count: diagnostics.pageErrors.length, sample: sample(diagnostics.pageErrors).map((entry) => ({ ...entry, message: shortText(entry.message, secrets) })) },
    requestFailures: { count: diagnostics.requestFailures.length, sample: sample(diagnostics.requestFailures).map((entry) => ({ ...entry, url: redact(entry.url, secrets), errorText: shortText(entry.errorText, secrets) })) },
    badResponses: { count: diagnostics.badResponses.length, sample: sample(diagnostics.badResponses).map((entry) => ({ ...entry, url: redact(entry.url, secrets) })) },
    ignoredExpectedAbortedSse: diagnostics.ignoredExpectedAbortedSse,
  };
}

function hasDiagnostics(diagnostics) {
  return diagnostics.consoleErrors.length > 0
    || diagnostics.pageErrors.length > 0
    || diagnostics.requestFailures.length > 0
    || diagnostics.badResponses.length > 0;
}

async function navigateToScreen(page, check, timeoutMs) {
  const navItem = page.locator('#hermesNav .nav-item').filter({ hasText: check.label }).first();
  await navItem.waitFor({ state: 'visible', timeout: timeoutMs });
  await navItem.click();
  await page.waitForFunction(({ label, selector }) => {
    const heading = document.querySelector('.screen-heading__title')?.textContent?.trim() || '';
    const screen = document.querySelector('#hermesScreen');
    return heading.includes(label) && Boolean(screen && screen.matches(selector));
  }, { label: check.label, selector: check.selector }, { timeout: timeoutMs });
  await page.waitForTimeout(250);

  const screen = page.locator('#hermesScreen');
  const heading = (await page.locator('.screen-heading__title').innerText()).trim();
  const viewVisible = await screen.isVisible();
  if (!viewVisible) throw new Error(`${check.id} view did not render visibly`);
  return {
    id: check.id,
    label: check.label,
    heading,
    viewSelector: check.selector,
    viewVisible,
  };
}

async function run() {
  const username = requiredEnv('HERMES_WEB_USERNAME');
  const password = requiredEnv('HERMES_WEB_PASSWORD');
  const target = targetUrl(requiredEnv('HERMES_WEB_URL'));
  const timeoutMs = positiveInteger(process.env.HERMES_WEB_TIMEOUT_MS, 45_000);
  const secrets = [username, password];
  const diagnostics = createDiagnostics();
  const screens = [];
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  const context = await browser.newContext({
    httpCredentials: { username, password },
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const sameOrigin = target.origin;

  page.on('console', (message) => {
    if (message.type() === 'error') {
      diagnostics.consoleErrors.push({ text: message.text(), location: message.location()?.url || '' });
    }
  });
  page.on('pageerror', (error) => {
    diagnostics.pageErrors.push({ message: error.message });
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure() || {};
    if (isExpectedAbortedSse(request, failure)) {
      diagnostics.ignoredExpectedAbortedSse += 1;
      return;
    }
    diagnostics.requestFailures.push({
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      errorText: failure.errorText || 'request failed',
    });
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    let origin = '';
    try { origin = new URL(response.url()).origin; } catch { return; }
    if (origin !== sameOrigin) return;
    diagnostics.badResponses.push({
      method: response.request().method(),
      url: response.url(),
      status: response.status(),
    });
  });

  try {
    await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.locator('#hermesNav').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.locator('#hermesScreen').waitFor({ state: 'visible', timeout: timeoutMs });

    for (const check of SCREEN_CHECKS) {
      screens.push(await navigateToScreen(page, check, timeoutMs));
    }

    if (hasDiagnostics(diagnostics)) {
      throw new Error('browser diagnostics reported one or more failures');
    }

    return {
      ok: true,
      baseUrl: redact(`${target.origin}${target.pathname}`, secrets),
      screens,
      diagnostics: diagnosticsSummary(diagnostics, secrets),
    };
  } catch (error) {
    if (error && typeof error === 'object') error.diagnostics = diagnostics;
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

run()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    const secrets = [process.env.HERMES_WEB_USERNAME, process.env.HERMES_WEB_PASSWORD];
    const diagnostics = error?.diagnostics || null;
    console.error(JSON.stringify({
      ok: false,
      error: shortText(error?.message || error, secrets),
      diagnostics: diagnostics ? diagnosticsSummary(diagnostics, secrets) : undefined,
    }, null, 2));
    process.exitCode = 1;
  });
