import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const auth = readFileSync(new URL('../electron/auth.ts', import.meta.url), 'utf8');

test('login screen separates workspace AuthKit login from Google Calendar OAuth', () => {
  assert.match(app, /Google 또는 이메일로 계속하기/);
  assert.match(app, /login-auth-boundary/);
  assert.match(app, /Google Calendar 연결은 로그인 후 시작 가이드에서 합니다/);
  assert.match(app, /앱 안에 Google 비밀번호를 입력하지 않습니다/);
});

test('AuthKit bridge explains WorkOS config missing for first-user setup', () => {
  assert.match(auth, /WORKOS_CONFIG_MISSING/);
  assert.match(auth, /WorkOS\(Google\/이메일\)/);
});
