// 离线交付资料目录的可重复演示：
// 1) linux / win32 两个平台各自采集（可选依赖与平台过滤的差异）
// 2) 采集后移动 dist-tag 并复核，证明目录能追溯到当时实际使用的元数据版本
// 3) 撤回版本后重新采集，撤回与可用版本使用不同状态
// 4) 损坏归档后重新采集，坏归档不落盘、状态可区分
// 所有输出落在 .local/catalogs/ 下，可随时用 src/query.mjs 重复查询。
import {rm, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createSource} from './source.mjs';
import {collectCatalog, verifyCatalog} from './catalog.mjs';

const baseDir = new URL('../.local/catalogs/', import.meta.url).pathname;
const section = title => process.stdout.write(`\n=== ${title} ===\n`);
const brief = catalog => ({
  outcome: catalog.summary.outcome,
  root: catalog.summary.root,
  byStatus: catalog.summary.counts.byStatus,
  conflicts: catalog.summary.conflicts.map(c => `${c.name}: ${c.versions.join(' vs ')}`),
  peerUnsatisfied: catalog.summary.counts.peerUnsatisfied,
  blobs: catalog.summary.counts.distinctBlobs
});

async function control(source, patch) {
  const response = await fetch(source.url + '/control', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(patch)
  });
  if (!response.ok) throw new Error(`控制失败: ${response.status}`);
  return response.json();
}

const source = await createSource();
try {
  await rm(baseDir, {recursive: true, force: true});
  await mkdir(baseDir, {recursive: true});
  process.stdout.write(`本地授权仓库: ${source.url}`);

  section('场景 1：linux 平台采集（循环 app<->helper、libx 双版本冲突、gadget 的 peer 不满足、win-tool 被平台过滤、missing-opt 缺失）');
  const linuxDir = join(baseDir, 'demo-linux');
  const linux = await collectCatalog({
    name: 'app',
    range: '^1.0.0',
    platform: {os: 'linux', cpu: 'x64'},
    outputDir: linuxDir,
    registries: [source.url]
  });
  process.stdout.write(JSON.stringify(brief(linux), null, 2) + '\n');

  section('场景 2：win32 平台采集（win-tool 成为可选已纳入，清单与 linux 不同）');
  const winDir = join(baseDir, 'demo-win32');
  const win = await collectCatalog({
    name: 'app',
    range: '^1.0.0',
    platform: {os: 'win32', cpu: 'x64'},
    outputDir: winDir,
    registries: [source.url]
  });
  process.stdout.write(JSON.stringify(brief(win), null, 2) + '\n');

  section('场景 3：采集后移动 dist-tag（latest 1.0.0 -> 2.0.0），复核展示元数据漂移且目录不被改写');
  const verifyBefore = await verifyCatalog(linuxDir);
  process.stdout.write(`移动前复核: ${verifyBefore.ok ? '无漂移' : '存在漂移'}\n`);
  await control(source, {tag: '2.0.0'});
  const verifyAfter = await verifyCatalog(linuxDir);
  process.stdout.write(JSON.stringify({
    ok: verifyAfter.ok,
    drift: verifyAfter.metadataDrift.map(d => ({name: d.name, status: d.status, storedRev: d.storedRev, currentRev: d.currentRev}))
  }, null, 2) + '\n');
  process.stdout.write(`目录仍固定在根版本: ${linux.summary.root.resolvedVersion}（快照哈希见 snapshots.jsonl）\n`);

  section('场景 4：撤回 app@1.0.0 后重新采集（withdrawn 与 available 分开计数）');
  await control(source, {withdrawn: true});
  const withdrawnDir = join(baseDir, 'demo-withdrawn');
  const withdrawn = await collectCatalog({
    name: 'app',
    range: '1.0.0',
    platform: {os: 'linux', cpu: 'x64'},
    outputDir: withdrawnDir,
    registries: [source.url]
  });
  process.stdout.write(JSON.stringify(brief(withdrawn), null, 2) + '\n');

  section('场景 5：开启坏归档后重新采集（helper 完整性核对失败，坏字节不落盘）');
  await control(source, {badArchive: true});
  const badDir = join(baseDir, 'demo-bad-archive');
  const bad = await collectCatalog({
    name: 'app',
    range: '1.0.0',
    platform: {os: 'linux', cpu: 'x64'},
    outputDir: badDir,
    registries: [source.url]
  });
  process.stdout.write(JSON.stringify(brief(bad), null, 2) + '\n');

  section('可重复查询示例');
  process.stdout.write([
    `node src/query.mjs summary   --dir ${linuxDir}`,
    `node src/query.mjs conflicts --dir ${linuxDir}`,
    `node src/query.mjs paths     --dir ${linuxDir} --name libx`,
    `node src/query.mjs edges     --dir ${linuxDir} --kind peer`,
    `node src/query.mjs nodes     --dir ${linuxDir} --status optional-platform-excluded`,
    `node src/query.mjs archive   --dir ${badDir} --node n1`,
    `node src/query.mjs verify    --dir ${linuxDir}`
  ].join('\n') + '\n');
} finally {
  await source.close();
}
