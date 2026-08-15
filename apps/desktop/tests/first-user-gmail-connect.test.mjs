import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const desktopRoot = new URL('../', import.meta.url);
const appSource = await readFile(new URL('src/App.tsx', desktopRoot), 'utf8');
const guideSource = await readFile(new URL('src/features/onboarding/OnboardingGuide.tsx', desktopRoot), 'utf8');
const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(desktopRoot),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});
const onboarding = await vite.ssrLoadModule('/src/features/onboarding/onboardingReadiness.ts');
const { OnboardingGuide } = await vite.ssrLoadModule('/src/features/onboarding/OnboardingGuide.tsx');
const { MailScreen } = await vite.ssrLoadModule('/src/features/communication/MailScreen.tsx');

after(async () => {
  await vite.close();
});

test('OnboardingGuide mail CTA renders and invokes onConnectMail, not calendar IPC', () => {
  const html = renderToStaticMarkup(createElement(OnboardingGuide, {
    readiness: onboarding.buildOnboardingReadiness({ skippedStepIds: ['calendar', 'wiki'] }),
    onConnectCalendar: async () => {},
    onConnectMail: async () => {},
    onSyncCalendar: async () => {},
    onOpenRunner: () => {},
    onOpenWiki: () => {},
    onOpenCalendarAi: () => {},
    onAddKnowledgeFile: async () => {},
    onDismiss: async () => {},
    onComplete: async () => {},
  }));

  assert.match(html, /data-testid="onboarding-action-mail"/);
  assert.match(html, />Google 메일 연결<\/button>/);
  assert.match(guideSource, /if \(actionKind === 'mail_open'\) \{\s*await onConnectMail\(\);\s*return;\s*\}/);
  assert.doesNotMatch(guideSource, /actionKind === 'mail_open'[\s\S]{0,120}onConnectCalendar/);
});

test('mailConnected is true only when backend connector is connected', () => {
  for (const connector of ['not_linked', 'reauthorization_required', 'authorizing', '']) {
    const readiness = onboarding.buildOnboardingReadiness({ mailConnected: connector === 'connected' });
    assert.equal(readiness.steps.find((step) => step.id === 'mail')?.ready, false);
  }
  const connected = onboarding.buildOnboardingReadiness({ mailConnected: true });
  assert.equal(connected.steps.find((step) => step.id === 'mail')?.ready, true);

  assert.match(appSource, /mailConnected: mailConnector === 'connected'/);
  assert.match(appSource, /setMailConnector\(text\(inbox\.connector, 'not_linked'\)\)/);
  assert.doesNotMatch(appSource, /mailConnected:\s*(?:mailItems\.length|Boolean\(state\.inbox)/);
});

test('MailScreen not_linked shows Google 메일 연결 and never says 준비 중입니다', () => {
  const html = renderToStaticMarkup(createElement(MailScreen, {
    inbox: [],
    connector: 'not_linked',
    activeMailId: '',
    setActiveMailId: () => {},
    addTaskFromMail: () => {},
    delegateMail: () => {},
    mailLoadError: '',
    reloadMail: () => {},
    connectGoogleMail: async () => {},
    connectionBusy: false,
  }));

  assert.match(html, />Google 메일 연결<\/button>/);
  assert.match(html, /Google 메일 읽기 전용/);
  assert.doesNotMatch(html, /준비 중입니다/);

  const retryHtml = renderToStaticMarkup(createElement(MailScreen, {
    inbox: [],
    connector: 'reauthorization_required',
    activeMailId: '',
    setActiveMailId: () => {},
    addTaskFromMail: () => {},
    delegateMail: () => {},
    mailLoadError: '',
    reloadMail: () => {},
    connectGoogleMail: async () => {},
    connectionBusy: false,
  }));
  assert.match(retryHtml, />Google 권한 다시 연결<\/button>/);
});

test('OnboardingGuide reports the Gmail authorization attempt as a connection', () => {
  const html = renderToStaticMarkup(createElement(OnboardingGuide, {
    readiness: onboarding.buildOnboardingReadiness({ skippedStepIds: ['calendar', 'wiki'] }),
    busy: true,
    pendingAction: 'mail_open',
    onConnectCalendar: async () => {},
    onConnectMail: async () => {},
    onSyncCalendar: async () => {},
    onOpenRunner: () => {},
    onOpenWiki: () => {},
    onOpenCalendarAi: () => {},
    onAddKnowledgeFile: async () => {},
    onDismiss: async () => {},
    onComplete: async () => {},
  }));

  assert.match(html, /연결 진행 중/);
  assert.match(html, /브라우저 승인 대기 중…/);
  assert.doesNotMatch(html, /동기화 진행 중/);
});

test('MailScreen connected disconnect calls the mail IPC path and hydrates backend truth', () => {
  let disconnectCalls = 0;
  const tree = MailScreen({
    inbox: [],
    connector: 'connected',
    activeMailId: '',
    setActiveMailId: () => {},
    addTaskFromMail: () => {},
    delegateMail: () => {},
    mailLoadError: '',
    reloadMail: () => {},
    connectGoogleMail: async () => {},
    disconnectGoogleMail: async () => { disconnectCalls += 1; },
    connectionBusy: false,
  });
  const buttons = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button') buttons.push(node);
    visit(node.props?.children);
  };
  visit(tree);
  const disconnectButton = buttons.find((button) => button.props.children === 'Google 메일 연결 해제');
  assert.ok(disconnectButton);
  disconnectButton.props.onClick();
  assert.equal(disconnectCalls, 1);

  assert.match(appSource, /async function disconnectGoogleMail\(\)[\s\S]*?window\.hermesDesktop\?\.disconnectGoogleMail/);
  assert.match(appSource, /<MailScreen[\s\S]*?disconnectGoogleMail=\{disconnectGoogleMail\}/);
  const disconnectBody = appSource.match(/async function disconnectGoogleMail\(\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.match(disconnectBody, /await hydrate\(\{ blocking: false \}\)/);
  assert.doesNotMatch(disconnectBody, /connectGoogleCalendar|syncCalendarSources|send|delete|star/);
});

test('Onboarding and MailScreen connect through the dedicated mail IPC then hydrate backend truth', () => {
  assert.match(appSource, /async function connectGoogleMail\(\)[\s\S]*?window\.hermesDesktop\?\.connectGoogleMail/);
  assert.match(appSource, /setOnboardingPendingAction\('mail_open'\)/);
  assert.match(appSource, /onConnectMail=\{connectGoogleMail\}/);
  assert.match(appSource, /<MailScreen[\s\S]*?connectGoogleMail=\{connectGoogleMail\}/);
  const connectBody = appSource.match(/async function connectGoogleMail\(\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.match(connectBody, /await hydrate\(\{ blocking: false \}\)/);
  assert.doesNotMatch(connectBody, /connectGoogleCalendar|syncCalendarSources/);
});
