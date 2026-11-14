// 采集入口：给定根包、版本范围与交付平台，沿授权仓库生成可查询的资料目录。
// 仅读取元数据与归档字节并核对完整性；不执行包脚本、不安装、不解包。
// 用法：
//   node src/collect.mjs --name app --range ^1.0.0 --os linux --cpu x64 \
//     --registry http://127.0.0.1:PORT --dir .local/catalogs/run1
import {collectCatalog} from './catalog.mjs';

function parseArgs(argv) {
  const args = {_: [], registry: []};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (key === 'registry') args.registry.push(argv[++i]);
      else args[key] = argv[++i];
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.name || !args.dir || args.registry.length === 0) {
    process.stderr.write('用法: node src/collect.mjs --name <包名> --dir <目录> --registry <授权仓库> [--range 范围] [--os linux] [--cpu x64]\n');
    process.exit(2);
  }
  const result = await collectCatalog({
    name: args.name,
    range: args.range ?? 'latest',
    platform: {os: args.os ?? process.platform, cpu: args.cpu ?? process.arch},
    outputDir: args.dir,
    registries: args.registry
  });
  process.stdout.write(JSON.stringify({
    outputDir: result.outputDir,
    outcome: result.summary.outcome,
    root: result.summary.root,
    counts: result.summary.counts
  }, null, 2) + '\n');
}

main().catch(error => {
  process.stderr.write(`采集失败: ${error.message}\n`);
  process.exit(1);
});
