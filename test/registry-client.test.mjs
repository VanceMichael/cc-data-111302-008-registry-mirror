import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAllowed, verifyIntegrity, UnauthorizedSourceError} from '../src/registry-client.mjs';
import {createTar, integrityOf} from '../src/tar.mjs';

test('只允许批准清单内的来源，协议与主机必须一致', () => {
  const allowed = ['http://127.0.0.1:8080', 'https://registry.example.internal'];
  assert.doesNotThrow(() => assertAllowed('http://127.0.0.1:8080/packages/app', allowed));
  assert.doesNotThrow(() => assertAllowed('https://registry.example.internal/archives/x/-/x-1.tgz', allowed));
  assert.throws(() => assertAllowed('http://127.0.0.1:9090/packages/app', allowed), UnauthorizedSourceError);
  assert.throws(() => assertAllowed('https://127.0.0.1:8080/packages/app', allowed), UnauthorizedSourceError);
  assert.throws(() => assertAllowed('http://evil.example/packages/app', allowed), UnauthorizedSourceError);
});

test('完整性核对：匹配通过，篡改字节失败', () => {
  const buffer = createTar([{name: 'package/package.json', data: '{}'}]);
  const integrity = integrityOf(buffer);
  const ok = verifyIntegrity(buffer, {integrity});
  assert.equal(ok.ok, true);
  assert.equal(ok.checks[0].ok, true);

  const tampered = Buffer.from(buffer);
  tampered[1024] ^= 0xff;
  const bad = verifyIntegrity(tampered, {integrity});
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.some(f => f.includes('sha512')));
});

test('缺少受支持的完整性值视为失败而非放行', () => {
  const result = verifyIntegrity(Buffer.from('x'), {integrity: 'md5-abc'});
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /缺少受支持/);
});
