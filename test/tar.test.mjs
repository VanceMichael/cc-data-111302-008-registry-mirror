import test from 'node:test';
import assert from 'node:assert/strict';
import {createTar, listTar, integrityOf} from '../src/tar.mjs';

test('tar 生成是确定性的且可只读解析', () => {
  const entries = [
    {name: 'package/package.json', data: JSON.stringify({name: 'x', version: '1.0.0'})},
    {name: 'package/README.md', data: 'hello'}
  ];
  const a = createTar(entries);
  const b = createTar(entries);
  assert.ok(a.equals(b), '相同输入必须产生相同字节');
  const listed = listTar(a);
  assert.deepEqual(listed.map(e => e.name), ['package/package.json', 'package/README.md']);
  assert.ok(listed.every(e => e.unsafe === false));
  assert.match(integrityOf(a), /^sha512-/);
});

test('tar 解析标记不可信路径', () => {
  const tar = createTar([{name: 'package/ok.txt', data: 'x'}]);
  assert.equal(listTar(tar)[0].unsafe, false);
  const evil = Buffer.from(tar);
  evil.write('../escape.txt', 0, 13, 'utf8');
  const listed = listTar(evil);
  assert.equal(listed[0].unsafe, true);
});

test('被截断的归档明确报错', () => {
  const tar = createTar([{name: 'package/a.txt', data: 'x'.repeat(600)}]);
  assert.throws(() => listTar(tar.subarray(0, 600)), /截断/);
});
