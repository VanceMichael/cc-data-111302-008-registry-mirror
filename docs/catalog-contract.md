# 离线资料目录契约

采集器只做两件事：读取授权仓库的包元数据、领取归档字节并核对完整性。它不执行包中的任何脚本、不调用安装器、不把归档解包到磁盘。

## 授权与完整性

- 启动采集时必须给出授权仓库清单（`--registry`，可多个）。任何元数据或归档请求在发出前做来源（协议+主机）校验，清单外来源直接抛 `UnauthorizedSourceError`；HTTP 重定向被禁用，避免被带离批准来源。
- 归档必须核对发布元数据 `dist.integrity`（sha256/sha384/sha512）与可选 `shasum`。核对失败的字节绝不写入目录，节点状态记为 `archive-corrupt`，并保留期望值/实际值/算法供审计。
- blob 按完整性摘要内容寻址。摘要相同的字节只存一份并可跨目录复用，但每个节点仍独立保留自己的发布身份（`name@version`、`dist`、请求路径），不同包/不同版本不会被合并。

## 依赖分类

边（`edges.jsonl`）的 `kind` 与状态分别表示：

- `prod`：普通依赖；
- `optional`：可选依赖，缺失记 `optional-missing`，平台不匹配记 `optional-platform-excluded`，都不升级为必需失败；
- `peer`：peer 约束，单独记录 `peerSatisfied`；无满足版本时边记 `peer-unmet`，目录结论降为 `partial` 而不是静默忽略。
- 平台过滤依据清单中的 `os`/`cpu`（支持 `!` 排除），同一根包在不同 `--os/--cpu` 下产出不同目录。

## 冲突与循环

- 同名包的不同版本各自成为独立节点（独立 `id` 与 `node_modules` 位置），并在 `catalog.json.conflicts` 与 `events.jsonl` 的 `conflict` 事件中保留双方版本、位置、被阻塞的范围与请求路径。不存在全局只保留一个同名包的“去重”。
- 循环依赖通过“已放置节点复用”终止，环上的复用写入 `reuse` 事件；`query paths` 输出完整请求链并标注回到已访问节点的位置。

## 状态与结论（不混用成功状态）

节点状态：`root-resolved`、`available`、`withdrawn`（元数据带撤回标记）、`archive-corrupt`、`archive-failed`、`optional-missing`、`optional-platform-excluded`、`peer-unmet`、`unresolved`。

目录结论 `outcome.level`：

- `complete`：全部必需资料完整可用；
- `partial`：仅有可选缺口或 peer 不满足；
- `degraded`：含撤回版本或归档损坏/无法领取；
- `unresolved`：存在必需依赖无法解析。

## 元数据快照与可复核性

每个 packument 读取后保存快照记录（`snapshots.jsonl`）：URL、HTTP 状态、ETag、服务端 `rev`、**原始字节的 sha256**、读取时间。解析出的每个节点与边都回链其快照哈希。

`query verify` 重新拉取元数据并与快照比对：标签移动等上游变化只在复核结果中报告漂移（`changed`/`removed-upstream`），目录本身不被静默改写——因此即使 dist-tag 在领取中途变化，目录仍能复核到当时实际使用的元数据版本。本地 blob 同时按登记的完整性值重新计算核对。

## 目录文件

```
catalog.json        汇总：请求、根解析、状态计数、冲突、结论、最近一次漂移复核
nodes.jsonl         每个解析节点：版本、位置、状态、资料完整度、归档核对结果与清单
edges.jsonl         每条依赖边：kind、范围、解析版本、平台、peer 满足性、请求路径
events.jsonl        解析事件：place/reuse/conflict/unresolved/dist-tag-resolved/peer-*
snapshots.jsonl     元数据字节快照（哈希、ETag、rev、时间）
blobs/<digest>.tgz  内容寻址的已核对归档；index.json 是其索引与归档条目清单
```

所有写入采用临时文件 + 原子改名，避免半成品目录。
