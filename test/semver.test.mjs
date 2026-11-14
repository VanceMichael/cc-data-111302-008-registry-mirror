import test from 'node:test';
import assert from 'node:assert/strict';
import {parse, compare, satisfies, maxSatisfying, isExact} from '../src/semver.mjs';

test('版本解析与比较', () => {
  assert.deepEqual(parse('1.2.3'), {major: 1, minor: 2, patch: 3, prerelease: []});
  assert.deepEqual(parse('1.2.3-beta.2').prerelease, ['beta', '2']);
  assert.equal(parse('not-a-version'), null);
  assert.equal(compare('1.2.3', '1.2.4'), -1);
  assert.equal(compare('2.0.0', '1.9.9'), 1);
  assert.equal(compare('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(compare('1.0.0-alpha.2', '1.0.0-alpha.1'), 1);
});

test('caret 与 tilde 范围', () => {
  assert.ok(satisfies('1.2.3', '^1.0.0'));
  assert.ok(!satisfies('2.0.0', '^1.0.0'));
  assert.ok(satisfies('1.9.9', '^1.0.0'));
  assert.ok(satisfies('1.2.9', '~1.2.0'));
  assert.ok(!satisfies('1.3.0', '~1.2.0'));
  assert.ok(satisfies('0.2.5', '^0.2.0'));
  assert.ok(!satisfies('0.3.0', '^0.2.0'));
});

test('比较符、x 范围与 OR', () => {
  assert.ok(satisfies('2.0.0', '>=1.0.0 <3.0.0'));
  assert.ok(!satisfies('3.0.0', '>=1.0.0 <3.0.0'));
  assert.ok(satisfies('1.5.0', '1.x'));
  assert.ok(satisfies('4.0.0', '*'));
  assert.ok(satisfies('2.0.0', '^1.0.0 || ^2.0.0'));
  assert.ok(!satisfies('3.0.0', '^1.0.0 || ^2.0.0'));
  assert.ok(satisfies('1.0.0', '1.0.0'));
});

test('预发布不被稳定范围意外选中', () => {
  assert.ok(!satisfies('2.0.0-beta.1', '^2.0.0'));
  assert.ok(satisfies('2.0.0-beta.1', '2.0.0-beta.1'));
  assert.ok(satisfies('2.0.0-beta.2', '>=2.0.0-beta.1'));
});

test('maxSatisfying 与精确范围识别', () => {
  assert.equal(maxSatisfying(['1.0.0', '1.2.0', '2.0.0'], '^1.0.0'), '1.2.0');
  assert.equal(maxSatisfying(['1.0.0', '2.0.0'], '^3.0.0'), null);
  assert.equal(isExact('1.2.3'), true);
  assert.equal(isExact('^1.2.3'), false);
});
