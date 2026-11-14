import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createTar, integrityOf} from './tar.mjs';
import {createHash} from 'node:crypto';

export function json(response, value, status = 200) {
  response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  response.end(JSON.stringify(value));
}

const CONTROL_FIELDS = new Set(['tag', 'withdrawn', 'badArchive']);

// 为某包某版本确定性地生成 tar 字节（仅合成 package.json/README，不含可执行脚本）。
function buildArchive(name, version, manifest) {
  const entries = [
    {
      name: `package/package.json`,
      data: JSON.stringify({name, version, ...manifest, dist: undefined}, null, 2) + '\n'
    },
    {name: 'package/README.md', data: `${name}@${version} 的离线合成归档，不用于安装。\n`}
  ];
  return createTar(entries);
}

export async function createSource({port = 0, host = '127.0.0.1'} = {}) {
  const initial = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
  const registry = JSON.parse(await readFile(new URL('../fixtures/registry.json', import.meta.url), 'utf8'));
  // 运行期可变控制状态，重启即回到 fixtures
  const state = {...initial};
  const pages = {};

  function buildPackument(name) {
    const doc = registry.packages[name];
    const versions = {};
    for (const [version, manifest] of Object.entries(doc.versions)) {
      const archive = buildArchive(name, version, manifest);
      versions[version] = {
        ...manifest,
        deprecated: state.withdrawn && name === 'app' && version === '1.0.0' ? '已撤回' : manifest.deprecated,
        dist: {
          tarball: `/archives/${encodeURIComponent(name)}/-/${encodeURIComponent(name.replace(/^@/, '') )}-${version}.tgz`,
          integrity: integrityOf(archive),
          shasum: createHash('sha1').update(archive).digest('hex')
        }
      };
    }
    const distTags = {...doc['dist-tags']};
    if (name === 'app' && state.tag) distTags.latest = state.tag;
    const revParts = [
      `latest=${distTags.latest ?? ''}`,
      ...Object.entries(distTags).filter(([tag]) => tag !== 'latest').map(([tag, value]) => `${tag}=${value}`),
      state.withdrawn && name === 'app' ? 'withdrawn=1.0.0' : '',
      state.badArchive && name === 'helper' ? 'bad-archive=1' : ''
    ].filter(Boolean);
    return {name, 'dist-tags': distTags, versions, rev: revParts.join(';')};
  }

  function inventory() {
    return {
      state: {...state},
      packages: Object.fromEntries(
        Object.entries(registry.packages).map(([name, doc]) => [
          name,
          {'dist-tags': buildPackument(name)['dist-tags'], versions: Object.keys(doc.versions)}
        ])
      )
    };
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://local.test');
      let text = '';
      for await (const chunk of request) {
        text += chunk;
        if (text.length > 8 * 1024 * 1024) return json(response, {error: '控制请求过大'}, 413);
      }
      let body = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          return json(response, {error: 'JSON无效'}, 400);
        }
      }
      if (url.pathname === '/health') return json(response, {status: 'ok'});
      if (url.pathname === '/state' || url.pathname === '/inventory') {
        return json(response, url.pathname === '/state' ? {...state} : inventory());
      }
      if (url.pathname === '/control' && request.method === 'POST') {
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return json(response, {error: '控制体必须是对象'}, 400);
        }
        const unknown = Object.keys(body).filter(key => !CONTROL_FIELDS.has(key));
        if (unknown.length) return json(response, {error: `不支持的控制字段: ${unknown.join(',')}`}, 400);
        Object.assign(state, body);
        return json(response, {...state});
      }
      if (Object.hasOwn(pages, url.pathname)) {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        return response.end(await readFile(new URL('../public/' + pages[url.pathname], import.meta.url)));
      }

      if (url.pathname.startsWith('/packages/')) {
        const name = decodeURIComponent(url.pathname.slice('/packages/'.length));
        if (!Object.hasOwn(registry.packages, name)) return json(response, {error: '未知包'}, 404);
        return json(response, buildPackument(name));
      }

      if (url.pathname.startsWith('/archives/')) {
        // /archives/:name/-/:file.tgz
        const parts = url.pathname.split('/');
        if (parts[3] !== '-' || parts.length !== 5) return json(response, {error: '归档路径无效'}, 404);
        const name = decodeURIComponent(parts[2]);
        const file = decodeURIComponent(parts[4]);
        const version = /-(\d+\.\d+\.\d+)\.tgz$/.exec(file)?.[1];
        const manifest = registry.packages[name]?.versions[version];
        if (!manifest) return json(response, {error: '未知归档'}, 404);
        response.setHeader('Content-Type', 'application/octet-stream');
        if (state.badArchive && name === 'helper') {
          // 演示坏归档：字节被替换，完整性必然不匹配
          return response.end(`损坏归档:${name}:${version}`);
        }
        return response.end(buildArchive(name, version, manifest));
      }

      return json(response, {error: '资源不存在'}, 404);
    } catch (error) {
      if (!response.headersSent) json(response, {error: error.message}, 500);
      else response.destroy();
    }
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
