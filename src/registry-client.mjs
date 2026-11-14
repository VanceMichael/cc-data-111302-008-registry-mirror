// 授权 npm 风格仓库客户端：只读取包元数据（packument）与归档字节。
// 硬约束：任何请求的来源必须在批准清单内；归档字节必须与发布元数据中的完整性值核对一致；
// 不执行归档中的任何脚本，不调用安装器，不解包到磁盘。
import {createHash} from 'node:crypto';

export class UnauthorizedSourceError extends Error {
  constructor(url) {
    super(`来源未获授权，已拒绝请求: ${url}`);
    this.name = 'UnauthorizedSourceError';
    this.url = url;
  }
}

export class IntegrityError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'IntegrityError';
    Object.assign(this, details);
  }
}

export class RegistryError extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = 'RegistryError';
    this.status = status;
    this.url = url;
  }
}

function originOf(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.host}`;
}

export function assertAllowed(urlValue, allowedOrigins) {
  const target = new URL(urlValue);
  const allowed = allowedOrigins.some(origin => {
    const base = new URL(origin);
    return target.protocol === base.protocol && target.host === base.host;
  });
  if (!allowed) throw new UnauthorizedSourceError(urlValue);
}

function hashBody(body, algorithm = 'sha256') {
  return `${algorithm}-${createHash(algorithm).update(body).digest('base64')}`;
}

async function httpGet(urlValue, {timeoutMs, etag}) {
  const headers = {'Accept': 'application/json'};
  if (etag) headers['If-None-Match'] = etag;
  const response = await fetch(urlValue, {
    headers,
    redirect: 'error', // 重定向可能把请求带离批准来源，直接视为失败
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = Buffer.from(await response.arrayBuffer());
  return {response, body};
}

// 元数据读取器：固定批准来源，记录每次读取的字节快照哈希与服务端版本标识。
export class PackumentFetcher {
  constructor(allowedRegistries, {timeoutMs = 5000} = {}) {
    this.allowedOrigins = allowedRegistries.map(originOf);
    this.timeoutMs = timeoutMs;
  }

  // 返回 {packument, snapshot:{url,etag,rev,bodySha256,fetchedAt,httpStatus}}
  async fetchPackument(name, {registry, etag} = {}) {
    const base = registry ?? this.allowedOrigins[0];
    const url = new URL(`${base}/packages/${encodeURIComponent(name)}`).href;
    assertAllowed(url, this.allowedOrigins);
    let result;
    try {
      result = await httpGet(url, {timeoutMs: this.timeoutMs, etag});
    } catch (error) {
      // undici 的 TypeError 可能把授权闸门错误包在 cause 中
      if (error.name === 'UnauthorizedSourceError' || error.cause?.name === 'UnauthorizedSourceError') {
        throw error.cause?.name === 'UnauthorizedSourceError' ? error.cause : error;
      }
      throw new RegistryError(`元数据请求失败: ${error.message}`, 0, url);
    }    const {response, body} = result;
    if (response.status === 304) return {notModified: true};
    if (!response.ok) {
      return {missing: response.status === 404, httpStatus: response.status, url};
    }
    let packument;
    try {
      packument = JSON.parse(body.toString('utf8'));
    } catch {
      throw new RegistryError('元数据不是有效 JSON', response.status, url);
    }
    return {
      packument,
      snapshot: {
        url,
        httpStatus: response.status,
        etag: response.headers.get('etag'),
        rev: packument.rev ?? null,
        bodySha256: hashBody(body),
        fetchedAt: new Date().toISOString()
      }
    };
  }
}

function parseIntegrity(integrity) {
  // npm integrity 形如 sha512-base64（可多算法以 || 连接），取受支持的部分
  return String(integrity)
    .split(/\s+/)
    .map(part => {
      const match = /^(sha(?:256|384|512))-([A-Za-z0-9+/]+={0,2})$/.exec(part);
      return match ? {algorithm: match[1], digest: match[2]} : null;
    })
    .filter(Boolean);
}

export function verifyIntegrity(buffer, dist) {
  const failures = [];
  const checks = [];
  const entries = parseIntegrity(dist?.integrity ?? '');
  if (entries.length === 0) failures.push('发布元数据缺少受支持的 integrity 值');
  for (const {algorithm, digest} of entries) {
    const actual = createHash(algorithm).update(buffer).digest('base64');
    const ok = actual === digest;
    checks.push({algorithm, expected: digest, actual, ok});
    if (!ok) failures.push(`${algorithm} 完整性不匹配`);
  }
  if (dist?.shasum) {
    const actual = createHash('sha1').update(buffer).digest('hex');
    const ok = actual === dist.shasum;
    checks.push({algorithm: 'sha1', expected: dist.shasum, actual, ok});
    if (!ok) failures.push('shasum 不匹配');
  }
  return {ok: failures.length === 0, failures, checks, byteLength: buffer.length};
}

// 仅沿批准仓库领取归档，并在返回前完成完整性核对。
export async function fetchArchive(allowedOrigins, registryOrigin, tarballPath, dist, {timeoutMs = 10000} = {}) {
  const tarballUrl = new URL(tarballPath, registryOrigin).href;
  assertAllowed(tarballUrl, allowedOrigins);
  let response;
  try {
    response = await fetch(tarballUrl, {redirect: 'error', signal: AbortSignal.timeout(timeoutMs)});
  } catch (error) {
    if (error.name === 'UnauthorizedSourceError') throw error;
    return {ok: false, reason: `archive-request-failed:${error.message}`, tarballUrl};
  }
  if (!response.ok) {
    return {ok: false, reason: `archive-http-${response.status}`, tarballUrl, httpStatus: response.status};
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const verification = verifyIntegrity(buffer, dist);
  return {...verification, tarballUrl, buffer, integrity: dist?.integrity ?? null};
}
