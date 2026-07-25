import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const desktopRoot = new URL('../', import.meta.url);
const shellCss = await readFile(new URL('src/styles.css', desktopRoot), 'utf8');
const onboardingCss = await readFile(
  new URL('src/features/onboarding/onboarding.css', desktopRoot),
  'utf8',
);
const agentCss = await readFile(
  new URL('src/features/agent-operations/agent-workspace.css', desktopRoot),
  'utf8',
);

function cssBlocks(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...source.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`, 'g'))]
    .map((match) => match[1]);
}

function lastCssBlock(source, selector) {
  const blocks = cssBlocks(source, selector);
  assert.ok(blocks.length > 0, `Missing CSS block for ${selector}`);
  return blocks.at(-1);
}

test('sidebar brand and search read as compact navigation chrome', () => {
  const mark = lastCssBlock(shellCss, '.brand-mark');
  assert.match(mark, /width:\s*18px/);
  assert.match(mark, /height:\s*18px/);

  const search = lastCssBlock(shellCss, '.sidebar-search');
  assert.match(search, /background:\s*transparent/);
  assert.match(search, /border:\s*1px solid transparent/);
});

test('onboarding progress uses an Orca-like compact workspace rail', () => {
  const steps = lastCssBlock(onboardingCss, '.onboarding-steps');
  assert.match(steps, /display:\s*grid/);
  assert.match(steps, /align-content:\s*start/);

  const step = lastCssBlock(onboardingCss, '.onboarding-steps button');
  assert.match(step, /grid-template-columns:\s*20px minmax\(0,\s*1fr\)/);
  assert.match(step, /background:\s*transparent/);
  assert.match(step, /border:\s*0/);

  const active = lastCssBlock(onboardingCss, '.onboarding-steps button[data-active="true"]');
  assert.match(active, /background:\s*var\(--panel\)/);
});

test('delegation is one compact frame and desktop controls are not touch-sized', () => {
  const delegate = lastCssBlock(agentCss, '.agent-delegate-bar');
  assert.match(delegate, /padding:\s*4px/);
  assert.match(delegate, /border-radius:\s*var\(--radius-control\)/);

  const textarea = lastCssBlock(agentCss, '.agent-delegate-bar textarea');
  assert.match(textarea, /min-height:\s*34px/);
  assert.match(textarea, /border:\s*0/);
  assert.match(textarea, /background:\s*transparent/);

  const send = lastCssBlock(agentCss, '.agent-delegate-send');
  assert.match(send, /height:\s*32px/);
  assert.match(send, /min-width:\s*58px/);

  const desktopControls = lastCssBlock(
    agentCss,
    '.agent-control-room button, .agent-control-room summary, .agent-control-room select, .agent-control-room textarea, .agent-control-room input, .agent-control-room a',
  );
  assert.match(desktopControls, /min-height:\s*30px/);

  const touchMedia = agentCss.slice(agentCss.indexOf('@media (max-width: 768px)'));
  assert.match(
    touchMedia,
    /\.agent-control-room button,[\s\S]*min-height:\s*44px/,
  );
});

test('approval actions keep flat row hierarchy at compact desktop density', () => {
  const action = lastCssBlock(agentCss, '.agent-approval-card > footer button');
  assert.match(action, /min-height:\s*30px/);
  assert.match(action, /border-radius:\s*var\(--radius-control\)/);
  assert.doesNotMatch(action, /box-shadow|gradient/);
});
