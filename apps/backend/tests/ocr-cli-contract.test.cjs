const assert = require('node:assert/strict');
const test = require('node:test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('Apple Vision OCR CLI helper is scaffolded for Korean image text extraction', async () => {
  const manifest = await readFile(path.join(root, 'tools/ocr-cli/Package.swift'), 'utf8');
  const source = await readFile(path.join(root, 'tools/ocr-cli/Sources/ocr-cli/main.swift'), 'utf8');

  assert.match(manifest, /name:\s*"ocr-cli"/);
  assert.match(source, /import Vision/);
  assert.match(source, /VNRecognizeTextRequest/);
  assert.match(source, /ko-KR/);
  assert.match(source, /JSONEncoder/);
});
