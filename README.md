# 授权软件包目录的依赖元数据与发布身份采集

用于离线交付资料登记的 Node.js 项目。它在本地 npm 风格仓库上演示：给定根包、版本范围与交付平台，采集出**明确版本的依赖关系、发布状态、资料完整度与归档内容**。采集过程只读取元数据与归档字节并核对完整性，不执行包中的脚本，也不调用安装器。

## 环境与命令

Node.js 22.22.1 或更新的 22.x，无运行时第三方依赖。

```sh
npm ci --ignore-scripts
npm run build
npm test
npm start                 # 仅启动本地来源
npm run demo              # 原有：来源 + 单次目录读取
npm run demo:offline      # 完整离线采集演示（标签移动/循环/peer/冲突/平台/坏归档）
```

`npm start` 在标准输出报告来源地址，默认绑定本机回环地址并使用动态端口；可通过 `HOST` 与 `PORT` 指定。

### 采集与查询

```sh
# 采集：根包 + 版本范围 + 交付平台 + 授权仓库，输出到资料目录
node src/collect.mjs --name app --range '^1.0.0' --os linux --cpu x64 \
  --registry http://127.0.0.1:8080 --dir .local/catalogs/run1

# 对已落盘目录做可重复查询，不触发任何安装或脚本
node src/query.mjs summary   --dir .local/catalogs/run1
node src/query.mjs nodes     --dir .local/catalogs/run1 [--status available]
node src/query.mjs edges     --dir .local/catalogs/run1 [--kind peer|prod|optional]
node src/query.mjs paths     --dir .local/catalogs/run1 --name libx      # 冲突/循环的可解释路径
node src/query.mjs conflicts --dir .local/catalogs/run1
node src/query.mjs archive   --dir .local/catalogs/run1 --node n1        # 完整性核对与归档条目
node src/query.mjs verify    --dir .local/catalogs/run1                  # 元数据漂移与 blob 复核
```

## 关键约束

- 普通依赖、可选依赖、peer 约束、平台过滤分别建边表示；可选缺失/平台排除不冒充必需失败。
- 同名包版本冲突保留为多个独立节点，附带请求路径，不做全局同名去重。
- 归档只沿批准仓库领取，逐字节核对 `dist.integrity`/`shasum`；相同摘要可复用字节，但发布身份各自保留；坏字节不落盘。
- 撤回版本、可选资料缺失、peer 不满足、坏归档与完整可用版本使用不同节点状态与目录结论（`complete`/`partial`/`degraded`/`unresolved`）。
- 每次元数据读取保存字节快照（哈希、ETag、rev、时间）；dist-tag 中途变化时，`verify` 报告漂移而目录仍可追溯到当时实际使用的元数据版本。

## 目录

- `src/source.mjs`：本地 npm 风格来源（数据驱动，确定性 tar 归档与完整性值）。
- `src/registry-client.mjs`：授权闸门、元数据读取、归档领取与完整性核对。
- `src/semver.mjs`：零依赖 semver 子集（caret/tilde/x/比较符/OR/预发布）。
- `src/tar.mjs`：确定性 ustar 归档生成与只读条目解析（不解包、不执行）。
- `src/resolver.mjs`：依赖图解析，分类建边、平台过滤、循环安全、冲突保留。
- `src/catalog.mjs`：采集编排、内容寻址 blob、资料目录落盘与复核。
- `src/collect.mjs` / `src/query.mjs`：采集与查询 CLI。
- `src/demo-offline.mjs`：可重复的全场景演示，输出在 `.local/catalogs/`。
- `fixtures/registry.json`：本地仓库包数据；`fixtures/source.json`：运行期控制初值。
- `docs/source-contract.md`：来源协议；`docs/catalog-contract.md`：目录契约与状态语义。
- `test/`：semver/tar/授权与完整性单测，以及来源与采集端到端集成测试。

运行期状态仅用于来源模拟，重启来源会回到 fixtures 中的值。接入业务自己的持久状态（含采集目录）使用 `.local/` 或明确的外部路径。来源管理入口 `/state` 和 `/control` 是本地操作设施，不能作为绕过采集器授权闸门的业务写入捷径。

## 容器

```sh
docker build -t registry-mirror:local .
docker run --rm --network none registry-mirror:local
docker run --rm --network none registry-mirror:local npm run demo:offline
```
