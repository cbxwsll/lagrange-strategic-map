import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPasswordComplexity } from '../src/lib/security.js';

const cases = [
  ['abcdefgh', false, '单类字母'],
  ['12345678', false, '单类数字'],
  ['!!!!!!!!', false, '单类特殊符号'],
  ['abcd1234', true, '字母加数字'],
  ['abcd!!!!', true, '字母加特殊符号'],
  ['1234!!!!', true, '数字加特殊符号'],
  ['abcd123!', true, '三类混合'],
  ['中文密码1234', true, '中文与数字混合']
];

for (const [password, valid, name] of cases) {
  test(`§11 加入密码边界：${name}${valid ? '通过' : '拒绝'}`, () => {
    if (valid) assert.doesNotThrow(() => assertPasswordComplexity(password, 'joinPassword'));
    else assert.throws(() => assertPasswordComplexity(password, 'joinPassword'));
  });
}
