// 资料目录采集与落盘：解析依赖图 -> 逐节点领取归档并核对完整性 -> 写成可重复查询的目录。
// 被撤回版本、可选资料缺失、平台排除、坏归档与完整可用版本分别使用不同状态，绝不合并为一种成功。
import {mkdir, writeFile, readFile, rename} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {PackumentFetcher, fetchArchive} from './registry-client.mjs';
import {resolveGraph} from './resolver.mjs';
import {listTar} from './tar.mjs';

export const NODE_STATUS = Object.freeze({
  ROOT_RESOLVED: 'root-resolved',
  AVAILABLE: 'available', // 归档完整可用
  WITHDRAWN: 'withdrawn', // 版本在元数据中被标记撤回
  ARCHIVE_CORRUPT: 'archive-corrupt', // 完整性核对失败
  ARCHIVE_FAILED: 'archive-failed', // 归档无法领取
  OPTIONAL_MISSING: 'optional-missing', // 可选依赖在仓库中不存在
  OPTIONAL_EXCLUDED: 'optional-platform-excluded', // 可选依赖与交付平台不匹配
  PEER_UNMET: 'peer-unmet', // peer 约束在可见节点中无满足版本
  UNRESOLVED: 'unresolved' // 必需依赖无法解析
});

const OUTCOME_ORDER = ['unresolved', 'degraded', 'partial', 'complete'];

function originOf(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.host}`;
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
}

function toJsonl(rows) {
  return rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
}

export async function collectCatalog({
  name,
  range,
  platform,
  outputDir,
  registries,
  timeoutMs = 10000,
  onPackumentFetched,
  now = () => new Date().toISOString()
}) {
  if (!Array.isArray(registries) || registries.length === 0) {
    throw new Error('必须提供至少一个授权仓库');
  }
  const allowedOrigins = registries.map(originOf);
  const registryOrigin = allowedOrigins[0];
  const fetcher = new PackumentFetcher(registries, {timeoutMs});
  const startedAt = now();

  const graph = await resolveGraph({
    root: {name, range},
    platform,
    fetcher,
    registry: registryOrigin,
    onPackumentFetched
  });

  const blobsDir = join(outputDir, 'blobs');
  await mkdir(blobsDir, {recursive: true});
  const blobs = new Map(); // integrity -> blob 记录（同摘要复用字节，保留各发布身份）
  const nodeRecords = [];

  function nodeStatus(node) {
    if (node.deprecated) return NODE_STATUS.WITHDRAWN;
    const archive = node.archive;
    if (archive?.status === 'corrupt') return NODE_STATUS.ARCHIVE_CORRUPT;
    if (archive?.status === 'failed') return NODE_STATUS.ARCHIVE_FAILED;
    if (node.kinds.includes('root')) return NODE_STATUS.ROOT_RESOLVED;
    return NODE_STATUS.AVAILABLE;
  }

  for (const node of graph.nodes) {
    const record = {...node, archive: null, materialCompleteness: null, status: null};
    if (!node.dist?.tarball || !node.dist?.integrity) {
      record.archive = {status: 'failed', reason: 'missing-dist-metadata'};
      record.status = NODE_STATUS.ARCHIVE_FAILED;
    } else {
      const existing = blobs.get(node.dist.integrity);
      if (existing) {
        // 相同完整性摘要复用字节；仍单独登记该发布身份（name@version、dist 不合并）
        record.archive = {
          status: 'reused',
          blob: existing.path,
          integrity: node.dist.integrity,
          tarballUrl: existing.tarballUrl,
          verified: true,
          byteLength: existing.byteLength,
          checks: existing.checks,
          listing: existing.listing,
          listingError: existing.listingError
        };
      } else {
        const result = await fetchArchive(allowedOrigins, registryOrigin, node.dist.tarball, node.dist, {timeoutMs});
        if (result.ok) {
          let listing = [];
          let listingError = null;
          try {
            listing = listTar(result.buffer).map(({dataStart, ...rest}) => rest);
          } catch (error) {
            listingError = error.message;
          }
          const safeName = result.integrity.replace(/[^A-Za-z0-9]/g, '_');
          const blobPath = join('blobs', `${safeName}.tgz`);
          await atomicWrite(join(outputDir, blobPath), result.buffer);
          const blobRecord = {
            blob: blobPath,
            path: blobPath,
            integrity: result.integrity,
            tarballUrl: result.tarballUrl,
            byteLength: result.byteLength,
            checks: result.checks,
            listing,
            listingError
          };
          blobs.set(result.integrity, blobRecord);
          record.archive = {status: 'verified', ...blobRecord};
        } else {
          record.archive = {
            status: result.failures?.length ? 'corrupt' : 'failed',
            reason: result.reason ?? result.failures?.join('; '),
            tarballUrl: result.tarballUrl,
            checks: result.checks ?? null,
            byteLength: result.byteLength ?? null
          };
          // 坏字节绝不落盘
        }
      }
    }
    record.status = nodeStatus(record);
    record.materialCompleteness = assessMaterial(record, graph);
    nodeRecords.push(record);
  }

  // 边状态：可选缺失/平台排除/未解析/peer 不满足都体现在这里
  const edgeRecords = graph.edges.map(edge => ({
    ...edge,
    status: edge.status ?? 'resolved',
    peerSatisfied: edge.kind === 'peer' ? Boolean(edge.peerSatisfied) : null
  }));

  // 没有产生节点的边（可选缺失、平台排除、必需未解析）补合成节点，使状态在节点视图中同样可查
  const resolvedNodeEdges = new Set(edgeRecords.filter(e => e.to).map(e => e.to));
  const pseudoByKey = new Map();
  for (const edge of edgeRecords) {
    if (edge.to) continue;
    const key = `${edge.name}@${edge.range}:${edge.status}`;
    if (pseudoByKey.has(key)) continue;
    const pseudo = {
      id: `missing-${pseudoByKey.size}`,
      name: edge.name,
      version: null,
      location: null,
      deprecated: null,
      os: null,
      cpu: null,
      platform: {os: platform.os, cpu: platform.cpu, compatible: false},
      snapshotSha256: edge.snapshotSha256 ?? null,
      dist: null,
      requestPaths: [edge.requestPath],
      kinds: [edge.kind],
      requestedBy: [{from: edge.from, range: edge.range, kind: edge.kind, optional: edge.optional}],
      archive: null,
      materialCompleteness: null,
      status: edge.status === 'optional-missing'
        ? NODE_STATUS.OPTIONAL_MISSING
        : edge.status === 'optional-platform-excluded'
          ? NODE_STATUS.OPTIONAL_EXCLUDED
          : edge.status === 'peer-unmet' || edge.status === 'peer-optional-unmet'
            ? NODE_STATUS.PEER_UNMET
            : NODE_STATUS.UNRESOLVED,
      failure: edge.failure ?? null
    };
    pseudoByKey.set(key, pseudo);
    nodeRecords.push(pseudo);
  }

  const statusCounts = countBy(nodeRecords.map(n => n.status));
  const outcome = deriveOutcome(nodeRecords, edgeRecords);

  const summary = {
    schemaVersion: 1,
    createdAt: now(),
    startedAt,
    request: {
      name,
      range,
      platform,
      registries: allowedOrigins
    },
    root: {
      name: graph.rootRequest.name,
      range: graph.rootRequest.range,
      resolvedVersion: graph.rootRequest.resolvedVersion,
      viaTag: graph.rootRequest.viaTag ?? null,
      nodeId: graph.nodes.find(n => n.kinds.includes('root'))?.id
    },
    counts: {
      nodes: nodeRecords.length,
      edges: edgeRecords.length,
      distinctBlobs: blobs.size,
      byStatus: statusCounts,
      conflicts: graph.conflicts.length,
      peerUnsatisfied: edgeRecords.filter(e => e.kind === 'peer' && e.peerSatisfied === false).length
    },
    conflicts: graph.conflicts,
    outcome,
    drift: null // verifyCatalog 会在复核对不上时补充
  };

  await atomicWrite(join(outputDir, 'catalog.json'), JSON.stringify(summary, null, 2) + '\n');
  await atomicWrite(join(outputDir, 'nodes.jsonl'), toJsonl(nodeRecords));
  await atomicWrite(join(outputDir, 'edges.jsonl'), toJsonl(edgeRecords));
  await atomicWrite(join(outputDir, 'events.jsonl'), toJsonl(graph.events));
  await atomicWrite(join(outputDir, 'snapshots.jsonl'), toJsonl(graph.packuments.filter(p => p.snapshot)));
  await atomicWrite(
    join(outputDir, 'blobs', 'index.json'),
    JSON.stringify([...blobs.values()].map(({buffer, ...rest}) => rest), null, 2) + '\n'
  );

  return {summary, nodes: nodeRecords, edges: edgeRecords, events: graph.events, snapshots: graph.packuments, outputDir};
}

function assessMaterial(node, graph) {
  // 资料完整度：归档、清单字段、平台适配、发布状态逐项给出
  const checks = {
    hasPackument: Boolean(node.snapshotSha256),
    hasDistIntegrity: Boolean(node.dist?.integrity),
    hasTarball: Boolean(node.dist?.tarball),
    archiveVerified: node.archive ? ['verified', 'reused'].includes(node.archive.status) : false,
    archiveListingParsed: node.archive?.listingError ? false : Boolean(node.archive?.listing),
    platformCompatible: node.platform?.compatible === true,
    notWithdrawn: !node.deprecated
  };
  const score = Object.values(checks).filter(Boolean).length;
  return {score, total: Object.keys(checks).length, checks};
}

function deriveOutcome(nodes, edges) {
  const statuses = new Set(nodes.map(n => n.status));
  const hasRequiredFailure = edges.some(e => !e.optional && e.kind !== 'peer'
      && (e.status === 'unresolved-missing' || e.status === 'unresolved-platform'))
    || statuses.has(NODE_STATUS.UNRESOLVED);
  const hasCorruption = statuses.has(NODE_STATUS.ARCHIVE_CORRUPT) || statuses.has(NODE_STATUS.ARCHIVE_FAILED);
  const hasOptionalGap = statuses.has(NODE_STATUS.OPTIONAL_MISSING)
    || statuses.has(NODE_STATUS.OPTIONAL_EXCLUDED)
    || edges.some(e => e.status?.startsWith('optional-'));
  const hasWithdrawn = statuses.has(NODE_STATUS.WITHDRAWN);
  const hasPeerIssue = statuses.has(NODE_STATUS.PEER_UNMET)
    || edges.some(e => e.kind === 'peer' && e.peerSatisfied === false);

  let level;
  const reasons = [];
  if (hasRequiredFailure) {
    level = 'unresolved';
    reasons.push('存在必需依赖无法解析');
  } else if (hasCorruption || hasWithdrawn) {
    level = 'degraded';
    if (hasCorruption) reasons.push('存在归档损坏或无法领取');
    if (hasWithdrawn) reasons.push('包含被撤回版本');
  } else if (hasOptionalGap || hasPeerIssue) {
    level = 'partial';
    if (hasOptionalGap) reasons.push('可选资料缺失或被平台过滤');
    if (hasPeerIssue) reasons.push('存在未满足的 peer 约束');
  } else {
    level = 'complete';
    reasons.push('全部必需资料完整可用');
  }
  return {level, reasons, rank: OUTCOME_ORDER.indexOf(level)};
}

function countBy(values) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

// 复核：重新拉取元数据与快照哈希比对，并重新核对本地 blob 完整性。
export async function verifyCatalog(outputDir, {timeoutMs = 10000} = {}) {
  const summary = JSON.parse(await readFile(join(outputDir, 'catalog.json'), 'utf8'));
  const fetcher = new PackumentFetcher(summary.request.registries, {timeoutMs});
  const snapshots = await readJsonl(join(outputDir, 'snapshots.jsonl'));
  const nodes = await readJsonl(join(outputDir, 'nodes.jsonl'));

  const drift = [];
  for (const record of snapshots) {
    if (!record.snapshot) continue;
    const fresh = await fetcher.fetchPackument(record.name, {etag: record.snapshot.etag});
    if (fresh.notModified) {
      drift.push({name: record.name, status: 'unchanged', etag: record.snapshot.etag});
      continue;
    }
    if (fresh.missing) {
      drift.push({name: record.name, status: 'removed-upstream', storedSha256: record.snapshot.bodySha256});
      continue;
    }
    const changed = fresh.snapshot.bodySha256 !== record.snapshot.bodySha256;
    drift.push({
      name: record.name,
      status: changed ? 'changed' : 'unchanged',
      storedSha256: record.snapshot.bodySha256,
      currentSha256: fresh.snapshot.bodySha256,
      storedRev: record.snapshot.rev,
      currentRev: fresh.snapshot.rev
    });
  }

  // 归档复核：按节点登记的完整性值重新计算本地 blob
  const blobChecks = [];
  for (const node of nodes) {
    if (!node.dist?.integrity) continue; // 合成节点（可选缺失/peer 未满足）没有归档，跳过
    const relative = node.archive?.blob;
    if (!relative) {
      // 采集时已记录的损坏/失败属于预期内“无本地 blob”，单独标注而非混入核对失败
      blobChecks.push({
        nodeId: node.id,
        name: node.name,
        version: node.version,
        status: node.archive?.status === 'corrupt' ? 'rejected-corrupt' : 'rejected-failed',
        reason: node.archive?.reason ?? null
      });
      continue;
    }
    const buffer = await readFile(join(outputDir, relative));
    const [algorithm, expected] = node.dist.integrity.split('-');
    const actual = createHash(algorithm).update(buffer).digest('base64');
    blobChecks.push({
      nodeId: node.id,
      name: node.name,
      version: node.version,
      status: actual === expected ? 'ok' : 'mismatch',
      integrity: node.dist.integrity
    });
  }

  const changed = drift.filter(d => d.status !== 'unchanged');
  const blobFailures = blobChecks.filter(b => b.status === 'mismatch');
  const result = {
    ok: changed.length === 0 && blobFailures.length === 0,
    metadataDrift: drift,
    blobChecks,
    note: '目录中的快照保留采集时实际使用的元数据版本；上游变化只记录漂移，不静默改写目录。'
  };
  summary.drift = {verifiedAt: new Date().toISOString(), changedCount: changed.length, details: drift};
  await atomicWrite(join(outputDir, 'catalog.json'), JSON.stringify(summary, null, 2) + '\n');
  return result;
}

async function readJsonl(path) {
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
