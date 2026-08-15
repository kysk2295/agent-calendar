import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const desktopRoot = new URL('../', import.meta.url);
const mailSource = await readFile(new URL('src/features/communication/MailScreen.tsx', desktopRoot), 'utf8');

test('Mail presents Gmail as a separate read-only consent and reply drafts as work', () => {
  assert.match(mailSource, /Gmail 읽기 권한은 Google Calendar 권한과 별도로 연결/);
  assert.doesNotMatch(mailSource, /Calendar[^\n]*Gmail[^\n]*한 번에|Gmail[^\n]*Calendar[^\n]*한 번에/);
  assert.match(mailSource, /답장 초안 작업/);
});
