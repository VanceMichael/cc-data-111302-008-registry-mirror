import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {collectCatalog, verifyCatalog} from '../src/catalog.mjs';
import {PackumentFetcher, UnauthorizedSourceError} from '../src/registry-client.mjs';

async function withSource(callback) {
  const source = await createSource();
  try {
    return await callback(source);
  } finally {
    await source.close();
  }
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'catalog-test-'));
}

async function control(source, patch) {
  const response = await fetch(source.url + '/control', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(patch)
  });
  assert.equal(response.status, 200);
}

async function readJsonl(path) {
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  // blobs/index.json 是普通 JSON 数组，其余目录文件是 JSONL
  if (path.endsWith('index.json')) return JSON.parse(text);
  return lines.map(line => JSON.parse(line));
}

async function collect(source, dir, overrides = {}) {
  return collectCatalog({
    name: 'app',
    range: '^1.0.0',
    platform: {os: 'linux', cpu: 'x64'},
    outputDir: dir,
    registries: [source.url],
    ...overrides
  });
}

test('完整采集产出可查询目录：节点、边、快照、blob 齐全', () => withSource(async source => {
  const dir = await tempDir();
  try {
    const result = await collect(source, dir);
    assert.equal(result.summary.root.resolvedVersion, '1.0.0');
    const names = result.nodes.map(n => n.name);
    for (const expected of ['app', 'helper', 'libx', 'gadget', 'host']) {
      assert.ok(names.includes(expected), `缺少节点 ${expected}`);
    }
    const onDisk = await readJsonl(join(dir, 'nodes.jsonl'));
    assert.equal(onDisk.length, result.nodes.length);
    const snapshots = await readJsonl(join(dir, 'snapshots.jsonl'));
    assert.ok(snapshots.every(s => s.snapshot?.bodySha256?.startsWith('sha256-')));
    const verified = result.nodes.filter(n => ['verified', 'reused'].includes(n.archive?.status));
    assert.ok(verified.length >= 5);
    assert.ok(verified.every(n => n.archive.checks?.some(c => c.ok)));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}));

test('普通、可选、peer、平台过滤分别表示', () => withSource(async source => {
  const dir = await tempDir();
  try {
    const {edges, nodes} = await collect(source, dir);
    const kinds = new Set(edges.map(e => e.kind));
    assert.deepEqual([...kinds].sort(), ['optional', 'peer', 'prod']);
    const winToolEdge = edges.find(e => e.name === 'win-tool');
    assert.equal(winToolEdge.kind, 'optional');
    assert.equal(winToolEdge.status, 'optional-platform-excluded');
    const winToolNode = nodes.find(n => n.name === 'win-tool');
    assert.equal(winToolNode.status, 'optional-platform-excluded');
    const missingEdge = edges.find(e => e.name === 'missing-opt');
    assert.equal(missingEdge.status, 'optional-missing');
    const peerEdges = edges.filter(e => e.kind === 'peer');
    assert.ok(peerEdges.some(e => e.peerSatisfied === true));
    assert.ok(peerEdges.some(e => e.peerSatisfied === false && e.status === 'peer-unmet'));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}));

test('win32 平台清单与 linux 不同：win-tool 被纳入', () => withSource(async source => {
  const linuxDir = await tempDir();
  const winDir = await tempDir();
  try {
    const linux = await collect(source, linuxDir);
    const win = await collect(source, winDir, {platform: {os: 'win32', cpu: 'x64'}});
    assert.equal(linux.nodes.find(n => n.name === 'win-tool').status, 'optional-platform-excluded');
    const winTool = win.nodes.find(n => n.name === 'win-tool');
    assert.equal(winTool.status, 'available');
    assert.equal(winTool.platform.os, 'win32');
    assert.notDeepEqual(
      new Map(linux.nodes.map(n => [`${n.name}@${n.version ?? 'x'}`, n.status])),
      new Map(win.nodes.map(n => [`${n.name}@${n.version ?? 'x'}`, n.status]))
    );
    assert.equal(linux.summary.counts.byStatus['optional-platform-excluded'] ?? 0, 1);
    assert.equal(win.summary.counts.byStatus['optional-platform-excluded'] ?? 0, 0);
  } finally {
    await rm(linuxDir, {recursive: true, force: true});
    await rm(winDir, {recursive: true, force: true});
  }
}));

test('同名多版本冲突全部保留并带可解释路径', () => withSource(async source => {
  const dir = await tempDir();
  try {
    const {nodes, summary, edges} = await collect(source, dir);
    const libx = nodes.filter(n => n.name === 'libx');
    assert.deepEqual(libx.map(n => n.version).sort(), ['1.0.0', '2.0.0']);
    assert.ok(libx.every(n => n.multiVersion?.versions.includes('1.0.0')));
    assert.equal(summary.conflicts[0].name, 'libx');
    assert.equal(summary.conflicts[0].versions.length, 2);
    assert.ok(edges.some(e => e.placement === 'nested-conflict'));
    // 两个版本各自保留独立的请求路径
    assert.ok(libx.every(n => n.requestPaths.length >= 1));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}));

test('循环依赖不会导致解析失控，且被事件记录', () => withSource(async source => {
  const dir = await tempDir();
  try {
    const {nodes, events} = await collect(source, dir);
    const appEdges = (await readJsonl(join(dir, 'edges.jsonl'))).filter(e => e.name === 'app' || e.name === 'helper');
    assert.ok(appEdges.length >= 2);
    assert.ok(nodes.length < 20, '循环不应造成节点无限增长');
    assert.ok(events.some(e => e.type === 'reuse'), '环上的重复请求应复用已放置节点');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}));

test('dist-tag 移动后复核能识别漂移，目录仍固定采集时版本', () => withSource(async source => {
  const dir = await tempDir();
  try {
    const result = await collect(source, dir);
    const before = await verifyCatalog(dir);
    assert.equal(before.ok, true);
    await control(source, {tag: '2.0.0'});
    const after = await verifyCatalog(dir);
    assert.equal(after.ok, false);
    const app = after.metadataDrift.find(d => d.name === 'app');
    assert.equal(app.status, 'changed');
    assert.notEqual(app.storedSha256, app.currentSha256);
    const untouched = after.metadataDrift.filter(d => d.name !== 'app');
    assert.ok(untouched.every(d => d.status === 'unchanged'));
    assert.equal(result.summary.root.resolvedVersion, '1.0.0');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}));

test('撤回版本使用独立 withdrawn 状态，不与可用版本混用', () => withSource(async source => {
  const dir = await tempDir();
  try {
    await control(source, {withdrawn: true});
    const {nodes, summary} = await collect(source, dir);
    const root = nodes.find(n => n.kinds.includes('root'));
    assert.equal(root.status, 'withdrawn');
    assert.equal(root.deprecated, '已撤回');
    assert.ok(summary.counts.byStatus.withdrawn >= 1);
    assert.ok(summary.counts.byStatus.available >= 1);
    assert.equal(summary.outcome.level, 'degraded');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}));

test('坏归档核对失败：坏字节不落盘，状态为 archive-corrupt', () => withSource(async source => {
  const dir = await tempDir();
  try {
    await control(source, {badArchive: true});
    const {nodes} = await collect(source, dir);
    const helper = nodes.find(n => n.name === 'helper');
    assert.equal(helper.status, 'archive-corrupt');
    assert.equal(helper.archive.status, 'corrupt');
    assert.ok(helper.archive.checks.some(c => !c.ok));
    const blobs = await readJsonl(join(dir, 'blobs', 'index.json'));
    assert.ok(blobs.every(b => b.integrity !== helper.dist.integrity || b.byteLength !== helper.archive.byteLength));
    assert.equal(summarySafe(nodes), true);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}));

function summarySafe(nodes) {
  return nodes.filter(n => n.status === 'archive-corrupt').every(n => !n.archive.blob);
}

test('相同完整性摘要复用字节，不同发布身份仍分别登记', () => withSource(async source => {
  const dirA = await tempDir();
  const dirB = await tempDir();
  try {
    const a = await collect(source, dirA);
    const b = await collect(source, dirB);
    const blobA = await readJsonl(join(dirA, 'blobs', 'index.json'));
    const blobB = await readJsonl(join(dirB, 'blobs', 'index.json'));
    const key = entry => entry.integrity;
    const shared = blobA.filter(x => blobB.some(y => key(y) === key(x)));
    assert.ok(shared.length >= 1);
    // 节点身份（name@version + dist）在两个目录中独立保留
    assert.equal(a.nodes[0].name, b.nodes[0].name);
    assert.equal(a.nodes[0].dist.integrity, b.nodes[0].dist.integrity);
  } finally {
    await rm(dirA, {recursive: true, force: true});
    await rm(dirB, {recursive: true, force: true});
  }
}));

test('未授权仓库的请求被拒绝', () => withSource(async source => {
  const dir = await tempDir();
  // 用不同主机名作为“虚假批准来源”，避免与动态分配端口的真实来源撞号
  const fakeAllowed = 'http://registry.unauthorized.invalid';
  try {
    // 清单只包含虚假来源：对运行来源的请求被授权闸门直接拒绝
    const fetcher = new PackumentFetcher([fakeAllowed]);
    await assert.rejects(
      () => fetcher.fetchPackument('app', {registry: source.url}),
      UnauthorizedSourceError
    );
    // 归档领取同样受闸门约束（直接对来源的 tarball URL 做来源校验）
    const {fetchArchive} = await import('../src/registry-client.mjs');
    await assert.rejects(
      () => fetchArchive([fakeAllowed], source.url, '/archives/app/-/app-1.0.0.tgz', {integrity: 'sha512-x'}),
      UnauthorizedSourceError
    );
    // 仅配置虚假来源时采集无法开始（网络不可达），不会静默改走其他来源
    await assert.rejects(
      () => collectCatalog({
        name: 'app',
        range: '^1.0.0',
        platform: {os: 'linux', cpu: 'x64'},
        outputDir: dir,
        registries: [fakeAllowed]
      }),
      /元数据请求失败/
    );
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}));

test('归档清单被解析并随目录保留，不做解包', () => withSource(async source => {
  const dir = await tempDir();
  try {
    const {nodes} = await collect(source, dir);
    const verified = nodes.find(n => n.archive?.status === 'verified');
    assert.ok(verified.archive.listing.some(e => e.name === 'package/package.json'));
    assert.equal(verified.archive.listingError, null);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}));
