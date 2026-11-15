import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COLOR_STORAGE_KEY, DEFAULT_COLORS, RELATION_KEYS, darkenColor, loadColors, resetColors, saveColors
} from '../public/assets/relation-colors.js';

test('六类调色持久化、恢复默认与浅色描边加深', () => {
  assert.deepEqual(Object.keys(DEFAULT_COLORS), RELATION_KEYS);
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const custom = saveColors({ ...DEFAULT_COLORS, self: '#123456', hostile: '#abcdef' }, storage);
  assert.equal(custom.self, '#123456');
  assert.equal(loadColors(storage).self, '#123456');
  assert.equal(loadColors(storage).hostile, '#abcdef');
  assert.ok(values.has(COLOR_STORAGE_KEY));
  assert.deepEqual(resetColors(storage), DEFAULT_COLORS);
  assert.equal(values.has(COLOR_STORAGE_KEY), false);
  assert.deepEqual(loadColors(storage), DEFAULT_COLORS);
  assert.equal(darkenColor('#ffffff'), '#b3b3b3');
  assert.equal(darkenColor(DEFAULT_COLORS.neutral), '#a18423');
  assert.notEqual(darkenColor(DEFAULT_COLORS.self), DEFAULT_COLORS.self);
});
