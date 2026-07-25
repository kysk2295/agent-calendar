'use strict';

/**
 * Standards-compliant QR encode → PNG → decode round-trip for enrollment payloads.
 * Uses qrcode (generator) + jsqr + pngjs (decoder). Not data-qr-payload attribute evidence.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

async function encodeDecode(payload) {
  const pngBuffer = await QRCode.toBuffer(payload, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
  });
  const png = PNG.sync.read(pngBuffer);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(decoded, 'jsQR must decode the PNG');
  return decoded.data;
}

test('enrollment qrPayload round-trips through standards-compliant QR PNG', async () => {
  const payload = JSON.stringify({
    v: 1,
    kind: 'agent-calendar-runner-enroll',
    baseUrl: 'http://127.0.0.1:4567',
    challengeId: 'ench_test_roundtrip_001',
    code: 'ABCD-EFGH-IJKL',
  });
  const decoded = await encodeDecode(payload);
  assert.equal(decoded, payload);
  const parsed = JSON.parse(decoded);
  assert.equal(parsed.kind, 'agent-calendar-runner-enroll');
  assert.equal(parsed.code, 'ABCD-EFGH-IJKL');
});

test('long enrollment payload with base URL still decodes', async () => {
  const payload = JSON.stringify({
    v: 1,
    kind: 'agent-calendar-runner-enroll',
    baseUrl: 'http://127.0.0.1:54321',
    challengeId: `ench_${'a'.repeat(32)}`,
    code: 'WXYZ-2345-6789',
  });
  const decoded = await encodeDecode(payload);
  assert.equal(decoded, payload);
});
