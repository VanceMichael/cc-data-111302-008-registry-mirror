# 来源协议

GET /packages/:name 返回本地 npm 风格元数据（packument），支持 scope 名称 URL 编码。数据由 `fixtures/registry.json` 驱动，服务重启即回到初始状态。

## 包集合与领域场景

- `app`：根包。1.0.0 依赖 `helper`/`libx`，可选 `win-tool`（仅 win32）与 `missing-opt`（仓库中不存在），peer 要求 `host ^2.0.0`；2.0.0 依赖上移，peer 要求 `host ^3.0.0`。
- `helper`：1.0.0 反向依赖 `app@1.0.0`，与根形成循环；同时要求 `libx ^2.0.0`，与根直接要求的 `libx ^1.0.0` 形成同名双版本冲突。
- `libx`：1.0.0 与 2.0.0 并存；2.0.0 依赖 `gadget`。
- `gadget`：peer 要求 `host ^4.0.0`，而仓库只提供 2.x/3.x，用于复现 peer 不满足。
- `win-tool`：声明 `os: [win32]`，用于平台过滤。
- `host`：提供 2.0.0/3.0.0，作为 peer 目标。

每个版本的 `dist` 含确定性生成的 tar 归档路径、sha512 `integrity` 与 sha1 `shasum`。归档为仅含 `package.json`/`README.md` 的合成 ustar 字节，不用于安装，也不含可执行脚本。

## 通用控制

`GET /inventory` 返回本来源当前目录摘要，`GET /health` 检查存活，`GET /state` 查看来源状态。`POST /control` 接收 JSON 对象，仅接受 `tag`、`withdrawn`、`badArchive` 三个字段，未知字段一律拒绝：

- `tag`：移动 `app` 的 `dist-tags.latest`，演示标签移动；
- `withdrawn`：在 `app@1.0.0` 上写入 `deprecated` 撤回标记；
- `badArchive`：把 `helper` 的归档字节替换为损坏内容，使完整性核对必然失败（坏字节由采集端拒绝落盘）。

packument 中的 `rev` 只随该包自身文档变化，因此移动 `app` 标签不会让其他包在复核时误报漂移。所有包名局限本地站点，不查询公网 registry。服务使用随机本地端口，测试启动与关闭均由代码负责，没有真实个人资料、凭据或付费调用。
