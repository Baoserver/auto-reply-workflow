const assert = require('node:assert/strict');
const test = require('node:test');

const { buildNestedConfig } = require('../dist/electron/configSerialization.js');

test('buildNestedConfig preserves OCR guard settings', () => {
  const config = buildNestedConfig({
    ocr_enabled: true,
    ocr_fast_mode: false,
    ocr_check_interval: 60,
    ocr_guard_enabled: true,
    ocr_guard_previous_check_interval: 20,
  });

  assert.equal(config.ocr.enabled, true);
  assert.equal(config.ocr.fast_mode, false);
  assert.equal(config.ocr.check_interval, 60);
  assert.equal(config.ocr.guard_enabled, true);
  assert.equal(config.ocr.guard_previous_check_interval, 20);
});
