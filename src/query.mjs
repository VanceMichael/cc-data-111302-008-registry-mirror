// 资料目录查询入口：只读取已落盘的目录文件，不触发安装或脚本执行。
// 用法：
//   node src/query.mjs summary   --dir .local/catalogs/demo-linux
//   node src/query.mjs nodes     --dir DIR [--status available] [--name app]
//   node src/query.mjs edges     --dir DIR [--kind peer|prod|optional]
//   node src/query.mjs paths     --dir DIR --name libx
//   node src/query.mjs conflicts --dir DIR
//   node src/query.mjs archive   --dir DIR --node n3
//   node src/query.mjs verify    --dir DIR
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {verifyCatalog} from './catalog.mjs';

function parseArgs(argv) {
  const args = {_: []};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else args._.push(argv[i]);
  }
  return args;
}

async function readJsonl(path) {
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function load(dir) {
  const [summary, nodes, edges, events, snapshots] = await Promise.all([
    readFile(join(dir, 'catalog.json'), 'utf8').then(JSON.parse),
    readJsonl(join(dir, 'nodes.jsonl')),
    readJsonl(join(dir, 'edges.jsonl')),
    readJsonl(join(dir, 'events.jsonl')),
    readJsonl(join(dir, 'snapshots.jsonl'))
  ]);
  return {summary, nodes, edges, events, snapshots};
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function explainPaths(edges, nodes, targetName) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const incoming = new Map();
  for (const edge of edges) {
    if (!edge.to) continue;
    const target = byId.get(edge.to);
    if (!incoming.has(target.id)) incoming.set(target.id, []);
    incoming.get(target.id).push(edge);
  }
  const results = [];
  const walk = (nodeId, trail, seen) => {
    if (seen.has(nodeId)) {
      results.push({path: [...trail], note: '循环回到已访问节点'});
      return;
    }
    const node = byId.get(nodeId);
    const parents = incoming.get(nodeId) ?? [];
    if (parents.length === 0) {
      results.push({path: [node.name + '@' + node.version, ...trail].reverse()});
      return;
    }
    for (const edge of parents) {
      walk(edge.from, [`${edge.name}@${node.version}  (${edge.kind}${edge.optional ? '/optional' : ''}, 范围 ${edge.range})`, ...trail], new Set([...seen, nodeId]));
    }
  };
  for (const node of nodes.filter(n => n.name === targetName)) {
    walk(node.id, [], new Set());
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const dir = args.dir;
  if (!command || !dir) {
    process.stderr.write('用法: node src/query.mjs <summary|nodes|edges|paths|conflicts|archive|verify> --dir DIR [选项]\n');
    process.exit(2);
  }
  const data = await load(dir);

  switch (command) {
    case 'summary':
      print(data.summary);
      break;
    case 'nodes': {
      let rows = data.nodes;
      if (args.status) rows = rows.filter(n => n.status === args.status);
      if (args.name) rows = rows.filter(n => n.name === args.name);
      print(rows.map(({id, name, version, location, status, kinds, deprecated, materialCompleteness, multiVersion}) => ({
        id, name, version, location, status, kinds, deprecated: Boolean(deprecated), multiVersion: multiVersion ?? null, materialCompleteness
      })));
      break;
    }
    case 'edges': {
      let rows = data.edges;
      if (args.kind) rows = rows.filter(e => e.kind === args.kind);
      print(rows);
      break;
    }
    case 'paths': {
      if (!args.name) throw new Error('paths 需要 --name');
      print(explainPaths(data.edges, data.nodes, args.name));
      break;
    }
    case 'conflicts':
      print({conflicts: data.summary.conflicts, events: data.events.filter(e => e.type === 'conflict')});
      break;
    case 'archive': {
      if (!args.node) throw new Error('archive 需要 --node');
      const node = data.nodes.find(n => n.id === args.node);
      if (!node) throw new Error(`节点不存在: ${args.node}`);
      print({id: node.id, name: node.name, version: node.version, dist: node.dist, archive: node.archive});
      break;
    }
    case 'verify':
      print(await verifyCatalog(dir));
      break;
    default:
      throw new Error(`未知命令: ${command}`);
  }
}

main().catch(error => {
  process.stderr.write(`查询失败: ${error.message}\n`);
  process.exit(1);
});
