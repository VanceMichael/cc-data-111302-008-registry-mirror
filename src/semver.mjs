// 只实现离线采集所需的 semver 子集：精确版本、比较符、caret、tilde、x 范围、OR、空格 AND 与预发布。
// 不引入第三方依赖，避免采集工具自身需要联网安装。

const FULL = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parse(version) {
  const match = FULL.exec(String(version).trim());
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre ? pre.split('.') : []
  };
}

function comparePre(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      const diff = Number(a[i]) - Number(b[i]);
      if (diff) return diff;
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

function compareParts(pa, pb) {
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  return comparePre(pa.prerelease, pb.prerelease);
}

export function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) throw new Error(`无法比较的版本: ${a} / ${b}`);
  return compareParts(pa, pb);
}

// 单个比较符 -> 上/下界 [low(含), high(不含或null)]
function comparatorBounds(token) {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?$/.exec(token.trim());
  if (!match) throw new Error(`不支持的版本范围片段: ${token}`);
  const [, op = '=', majRaw, minRaw, patRaw, pre] = match;
  const X = value => value === undefined || value === 'x' || value === 'X' || value === '*';
  const maj = X(majRaw) ? null : Number(majRaw);
  const min = X(minRaw) ? null : Number(minRaw);
  const pat = X(patRaw) ? null : Number(patRaw);
  const prerelease = pre ? pre.split('.') : [];
  const v = (major, minor, patch, p = []) => ({major, minor, patch, prerelease: p});

  if (maj === null) return [v(0, 0, 0), null]; // * / x
  if (op === '^') {
    if (min === null) return [v(maj, 0, 0), v(maj + 1, 0, 0)];
    if (pat === null) return [v(maj, min, 0), v(maj === 0 ? 0 : maj + 1, maj === 0 ? min + 1 : 0, 0)];
    const low = v(maj, min, pat, prerelease);
    if (maj > 0) return [low, v(maj + 1, 0, 0)];
    if (min > 0) return [low, v(0, min + 1, 0)];
    if (pat > 0 || prerelease.length) return [low, v(0, 0, pat + 1)];
    return [low, v(1, 0, 0)];
  }
  if (op === '~') {
    if (min === null) return [v(maj, 0, 0), v(maj + 1, 0, 0)];
    if (pat === null) return [v(maj, min, 0), v(maj, min + 1, 0)];
    return [v(maj, min, pat, prerelease), v(maj, min + 1, 0)];
  }
  // 无符号或 = 且带 x 部分时按 x 范围处理
  if (min === null) return [v(maj, 0, 0), v(maj + 1, 0, 0)];
  if (pat === null) return [v(maj, min, 0), v(maj, min + 1, 0)];
  const exact = v(maj, min, pat, prerelease);
  if (op === '=' || op === undefined) return [exact, v(maj, min, pat + 1)];
  if (op === '>=') return [exact, null];
  if (op === '>') return [exact, null, false, true];
  if (op === '<=') return [v(0, 0, 0), exact, true];
  if (op === '<') return [v(0, 0, 0), exact];
  throw new Error(`不支持的比较符: ${op}`);
}

function inBounds(parsed, bounds) {
  const [low, high, inclusiveHigh = false, lowExclusive = false] = bounds;
  if (low) {
    const c = compareParts(parsed, low);
    if (lowExclusive ? c <= 0 : c < 0) return false;
  }
  if (high) {
    const c = compareParts(parsed, high);
    if (inclusiveHigh ? c > 0 : c >= 0) return false;
  }
  return true;
}

// 解析一个 AND 组（空格连接的比较符）
function parseGroup(group) {
  const tokens = group.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return {boundsList: [], tuples: []};
  const boundsList = tokens.map(comparatorBounds);
  // 预发布版本只有在某比较符显式引用相同 major.minor.patch 时才可满足（npm 语义的简化版）
  const tuples = tokens
    .map(token => /^[~^]?\s*(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(token))
    .filter(Boolean)
    .map(match => [Number(match[1]), Number(match[2]), Number(match[3])]);
  return {boundsList, tuples};
}

export function satisfies(version, range) {
  const parsed = parse(version);
  if (!parsed) return false;
  const text = String(range).trim();
  if (text === '' || text === '*' || text.toLowerCase() === 'latest') {
    return parsed.prerelease.length === 0;
  }
  return text.split('||').some(part => {
    const {boundsList, tuples} = parseGroup(part);
    if (boundsList.length === 0) return parsed.prerelease.length === 0;
    if (parsed.prerelease.length && !tuples.some(([m, n, p]) => m === parsed.major && n === parsed.minor && p === parsed.patch)) {
      // 只有显式出现同 [major,minor,patch] 预发布比较符（如 >=2.0.0-beta.1）才允许预发布版本
      const allowsPre = tokensAllowsPrerelease(part, parsed);
      if (!allowsPre) return false;
    }
    return boundsList.every(bounds => inBounds(parsed, bounds));
  });
}

function tokensAllowsPrerelease(group, parsed) {
  const explicit = /(?:>=|>|\^|~|=)?\s*(\d+)\.(\d+)\.(\d+)-([0-9A-Za-z.-]+)/.exec(group);
  return Boolean(explicit)
    && Number(explicit[1]) === parsed.major
    && Number(explicit[2]) === parsed.minor
    && Number(explicit[3]) === parsed.patch;
}

export function maxSatisfying(versions, range) {
  const matched = versions.filter(v => satisfies(v, range)).sort(compare);
  return matched.length ? matched[matched.length - 1] : null;
}

export function isExact(range) {
  return FULL.test(String(range).trim());
}
