// 依赖图解析：普通依赖、可选依赖、peer 约束、平台过滤分别表示。
// 冲突不做全局去重：同名包的不同版本各自成为独立节点，并保留完整请求路径用于解释。
import {maxSatisfying, satisfies, isExact} from './semver.mjs';

const ROOT_LOCATION = '';
const ROOT_ID = '__root__';

function platformCompatible(manifest, platform) {
  if (Array.isArray(manifest.os) && manifest.os.length) {
    const allowed = manifest.os.filter(entry => !entry.startsWith('!'));
    const denied = manifest.os.filter(entry => entry.startsWith('!')).map(entry => entry.slice(1));
    if (allowed.length && !allowed.includes(platform.os)) return {ok: false, reason: `os 不匹配: 要求 ${allowed.join('|')}，当前 ${platform.os}`};
    if (denied.includes(platform.os)) return {ok: false, reason: `os 被排除: ${platform.os}`};
  }
  if (Array.isArray(manifest.cpu) && manifest.cpu.length) {
    const allowed = manifest.cpu.filter(entry => !entry.startsWith('!'));
    const denied = manifest.cpu.filter(entry => entry.startsWith('!')).map(entry => entry.slice(1));
    if (allowed.length && !allowed.includes(platform.cpu)) return {ok: false, reason: `cpu 不匹配: 要求 ${allowed.join('|')}，当前 ${platform.cpu}`};
    if (denied.includes(platform.cpu)) return {ok: false, reason: `cpu 被排除: ${platform.cpu}`};
  }
  return {ok: true};
}

function parentLocations(location) {
  // 沿 node_modules 向上查找的位置序列（自身 → 根）
  const chain = [location];
  let current = location;
  while (current.includes('/node_modules/')) {
    current = current.slice(0, current.lastIndexOf('/node_modules/'));
    chain.push(current);
  }
  chain.push(ROOT_LOCATION);
  return [...new Set(chain)];
}

function childLocation(parentLocation, name) {
  return parentLocation === ROOT_LOCATION ? `node_modules/${name}` : `${parentLocation}/node_modules/${name}`;
}

export async function resolveGraph({root: rootRequest, platform, fetcher, registry, onPackumentFetched}) {
  const packuments = new Map(); // name -> {packument, snapshot}
  const nodesById = new Map();
  const nodesByLocation = new Map();
  const edges = [];
  const events = [];

  async function loadPackument(name, {optional}) {
    if (packuments.has(name)) return packuments.get(name);
    const record = await fetcher.fetchPackument(name, {registry});
    if (onPackumentFetched) onPackumentFetched(name, record);
    if (record.missing) {
      events.push({type: 'packument-missing', name, optional, httpStatus: record.httpStatus});
      packuments.set(name, {missing: true, httpStatus: record.httpStatus});
      return packuments.get(name);
    }
    packuments.set(name, record);
    return record;
  }

  function pickVersion(name, range, packument, {optional}) {
    const distTags = packument['dist-tags'] ?? {};
    let wanted = range;
    let viaTag = null;
    if (!isExact(range) && Object.hasOwn(distTags, range)) {
      wanted = distTags[range];
      viaTag = {tag: range, resolved: wanted};
      events.push({type: 'dist-tag-resolved', name, tag: range, version: wanted});
    }
    const versions = Object.keys(packument.versions ?? {});
    const compatible = versions.filter(version => platformCompatible(packument.versions[version], platform).ok);
    const candidate = maxSatisfying(compatible, wanted);
    if (!candidate) {
      return {
        failure: {
          reason: compatible.length === 0 ? 'no-platform-compatible-version' : 'no-version-in-range',
          range,
          available: versions,
          platformCompatible: compatible,
          viaTag
        }
      };
    }
    return {version: candidate, viaTag};
  }

  async function requireEdge({parentId, parentLocation, name, range, kind, optional, requestPath}) {
    const edge = {from: parentId, name, range, kind, optional, requestedAt: new Date().toISOString(), requestPath: [...requestPath]};
    const loaded = await loadPackument(name, {optional});
    if (loaded.missing) {
      edge.status = optional ? 'optional-missing' : 'unresolved-missing';
      edge.failure = {reason: 'registry-404', httpStatus: loaded.httpStatus};
      edges.push(edge);
      events.push({type: 'unresolved', name, range, kind, optional, reason: edge.failure.reason, requestPath: edge.requestPath});
      return;
    }
    const {packument, snapshot} = loaded;
    edge.snapshotSha256 = snapshot.bodySha256;

    // 平台过滤：先看最新可取版本是否存在平台兼容候选
    const picked = pickVersion(name, range, packument, {optional});
    if (picked.failure) {
      const incompat = versions =>
        versions.map(v => ({version: v, platform: platformCompatible(packument.versions[v], platform)}));
      if (kind === 'peer') {
        edge.status = edge.optional ? 'peer-optional-unmet' : 'peer-unmet';
      } else if (optional) {
        edge.status = picked.failure.reason === 'no-platform-compatible-version'
          ? 'optional-platform-excluded'
          : 'optional-unresolved';
      } else {
        edge.status = picked.failure.reason === 'no-platform-compatible-version'
          ? 'unresolved-platform'
          : 'unresolved-missing';
      }
      edge.failure = {...picked.failure, details: incompat(picked.failure.available)};
      edges.push(edge);
      events.push({type: 'unresolved', name, range, kind, optional, reason: edge.failure.reason, requestPath: edge.requestPath});
      return;
    }

    const {version, viaTag} = picked;
    edge.resolvedVersion = version;
    edge.viaTag = viaTag;
    const manifest = packument.versions[version];
    const platformCheck = platformCompatible(manifest, platform);
    edge.platform = {os: platform.os, cpu: platform.cpu, compatible: platformCheck.ok};

    // 沿祖先链复用满足范围的已放置节点（提升）
    const visible = parentLocations(parentLocation)
      .map(loc => nodesByLocation.get(childLocation(loc, name)))
      .filter(Boolean);
    const reusable = visible.find(node => satisfies(node.version, range) && node.platform.compatible);
    if (reusable) {
      edge.to = reusable.id;
      edge.placement = 'reused';
      edges.push(edge);
      events.push({type: 'reuse', name, version, location: reusable.location, requestPath: edge.requestPath});
      return;
    }

    // 选位：优先提升到根层；根层被不兼容版本占据时下沉到请求者本地，两个版本都保留
    const rootLocation = childLocation(ROOT_LOCATION, name);
    const rootOccupant = nodesByLocation.get(rootLocation);
    let targetLocation;
    let conflictWith = null;
    if (!rootOccupant) {
      targetLocation = rootLocation;
    } else if (satisfies(rootOccupant.version, range)) {
      // 理论上已被上方复用逻辑覆盖，这里防御性处理
      edge.to = rootOccupant.id;
      edge.placement = 'reused';
      edges.push(edge);
      return;
    } else {
      targetLocation = childLocation(parentLocation, name);
      conflictWith = rootOccupant;
    }

    const node = {
      id: `n${nodesById.size}`,
      name,
      version,
      location: targetLocation,
      deprecated: manifest.deprecated ?? null,
      os: manifest.os ?? null,
      cpu: manifest.cpu ?? null,
      platform: {os: platform.os, cpu: platform.cpu, compatible: platformCheck.ok},
      snapshotSha256: snapshot.bodySha256,
      dist: manifest.dist ?? null,
      requestPaths: [[...requestPath, `${name}@${version}`]],
      kinds: new Set([kind]),
      requestedBy: [{from: parentId, range, kind, optional}]
    };
    if (conflictWith) {
      // 根层已被别的版本占据：嵌套保留，并显式记录冲突
      edge.placement = 'nested-conflict';
      events.push({
        type: 'conflict',
        name,
        versions: [conflictWith.version, version],
        locations: [conflictWith.location, targetLocation],
        blockedRange: range,
        requestPath: edge.requestPath
      });
    }
    nodesById.set(node.id, node);
    nodesByLocation.set(node.location, node);
    edge.to = node.id;
    if (edge.placement !== 'nested-conflict') edge.placement = 'new';
    edges.push(edge);
    events.push({type: 'place', name, version, location: node.location, kind, requestPath: edge.requestPath});

    await expandNode(node, manifest, edge.requestPath);
  }

  async function expandNode(node, manifest, parentPath) {
    const requestPath = [...parentPath, `${node.name}@${node.version}`];
    const deps = [
      ...Object.entries(manifest.dependencies ?? {}).map(([name, range]) => ({name, range, kind: 'prod', optional: false})),
      ...Object.entries(manifest.optionalDependencies ?? {}).map(([name, range]) => ({name, range, kind: 'optional', optional: true})),
      ...Object.entries(manifest.peerDependencies ?? {}).map(([name, range]) => ({name, range, kind: 'peer', optional: Boolean(manifest.peerDependenciesMeta?.[name]?.optional)}))
    ];
    // 同一名称在多种依赖里出现时，npm 以 optionalDependencies 优先；这里分别保留边但去重请求
    const seen = new Set();
    for (const dep of deps) {
      const key = `${dep.name}:${dep.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await requireEdge({
        parentId: node.id,
        parentLocation: node.location,
        name: dep.name,
        range: dep.range,
        kind: dep.kind,
        optional: dep.optional,
        requestPath
      });
    }
  }

  // 根节点
  const rootLoaded = await loadPackument(rootRequest.name, {optional: false});
  if (rootLoaded.missing) throw new Error(`根包在授权仓库中不存在: ${rootRequest.name}`);
  const rootPicked = pickVersion(rootRequest.name, rootRequest.range, rootLoaded.packument, {optional: false});
  if (rootPicked.failure) throw new Error(`根包版本无法解析: ${rootRequest.range}（${rootPicked.failure.reason}）`);
  const rootManifest = rootLoaded.packument.versions[rootPicked.version];
  const rootNode = {
    id: ROOT_ID,
    name: rootRequest.name,
    version: rootPicked.version,
    location: ROOT_LOCATION,
    deprecated: rootManifest.deprecated ?? null,
    os: rootManifest.os ?? null,
    cpu: rootManifest.cpu ?? null,
    platform: {os: platform.os, cpu: platform.cpu, compatible: platformCompatible(rootManifest, platform).ok},
    snapshotSha256: rootLoaded.snapshot.bodySha256,
    dist: rootManifest.dist ?? null,
    requestPaths: [[`${rootRequest.name}@${rootPicked.version}`]],
    kinds: new Set(['root']),
    requestedBy: []
  };
  nodesById.set(rootNode.id, rootNode);
  nodesByLocation.set(ROOT_LOCATION, rootNode); // 根位置以空串登记，子位置统一走 childLocation
  await expandNode(rootNode, rootManifest, []);

  // 第二轮：peer 满足性评估（在完整图上检查可见节点），不满足不删边
  for (const edge of edges.filter(e => e.kind === 'peer')) {
    if (edge.to) {
      const target = nodesById.get(edge.to);
      edge.peerSatisfied = satisfies(target.version, edge.range);
    } else {
      edge.peerSatisfied = false;
      // peer 缺失：在根层补一个 peer 身份的解析尝试；根位被别的版本占据时在请求者下嵌套，保留多版本
      const loaded = packuments.get(edge.name);
      if (loaded && !loaded.missing) {
        const picked = pickVersion(edge.name, edge.range, loaded.packument, {optional: edge.optional});
        if (!picked.failure) {
          const requester = nodesById.get(edge.from);
          const candidateLocation = childLocation(ROOT_LOCATION, edge.name);
          const existing = nodesByLocation.get(candidateLocation);
          if (existing && satisfies(existing.version, edge.range)) {
            edge.to = existing.id;
            edge.peerSatisfied = true;
            existing.kinds.add('peer');
          } else {
            const manifest = loaded.packument.versions[picked.version];
            const location = existing
              ? childLocation(requester.location, edge.name)
              : candidateLocation;
            const peerNode = {
              id: `n${nodesById.size}`,
              name: edge.name,
              version: picked.version,
              location,
              deprecated: manifest.deprecated ?? null,
              os: manifest.os ?? null,
              cpu: manifest.cpu ?? null,
              platform: {os: platform.os, cpu: platform.cpu, compatible: platformCompatible(manifest, platform).ok},
              snapshotSha256: loaded.snapshot.bodySha256,
              dist: manifest.dist ?? null,
              requestPaths: [[...edge.requestPath, `${edge.name}@${picked.version}`]],
              kinds: new Set(['peer']),
              requestedBy: [{from: edge.from, range: edge.range, kind: 'peer', optional: edge.optional}]
            };
            nodesById.set(peerNode.id, peerNode);
            nodesByLocation.set(peerNode.location, peerNode);
            edge.to = peerNode.id;
            edge.peerSatisfied = satisfies(peerNode.version, edge.range);
            edge.placement = existing ? 'peer-nested-conflict' : 'peer-root';
            if (existing) {
              events.push({
                type: 'conflict',
                name: edge.name,
                versions: [existing.version, picked.version],
                locations: [existing.location, location],
                blockedRange: edge.range,
                requestPath: edge.requestPath
              });
            }
            events.push({type: 'peer-placement', name: edge.name, version: picked.version, location, requestPath: edge.requestPath});
          }
        }
      }
    }
    events.push({
      type: 'peer-evaluated',
      name: edge.name,
      range: edge.range,
      satisfied: edge.peerSatisfied,
      optional: edge.optional,
      requestPath: edge.requestPath
    });
  }

  // 汇总同名多版本（冲突）标记
  const byName = new Map();
  for (const node of nodesById.values()) {
    if (!byName.has(node.name)) byName.set(node.name, []);
    byName.get(node.name).push(node);
  }
  const conflicts = [];
  for (const [name, group] of byName) {
    const versions = [...new Set(group.map(n => n.version))];
    if (versions.length > 1) {
      for (const node of group) node.multiVersion = {name, versions};
      conflicts.push({name, versions: versions.sort(), nodeIds: group.map(n => n.id)});
    }
  }

  const nodes = [...nodesById.values()].map(node => ({...node, kinds: [...node.kinds]}));
  return {
    rootRequest: {...rootRequest, resolvedVersion: rootNode.version, viaTag: rootPicked.viaTag},
    platform,
    nodes,
    edges,
    conflicts,
    events,
    packuments: [...packuments.entries()].map(([name, record]) => ({
      name,
      missing: Boolean(record.missing),
      httpStatus: record.httpStatus ?? record.snapshot?.httpStatus,
      snapshot: record.snapshot ?? null
    }))
  };
}
