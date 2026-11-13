# 来源协议

GET /packages/:name 返回本地 npm 风格元数据，支持 scope 名称URL编码。根包 app 的1.0.0依赖 helper、可选 win-tool，并要求 host 的peer范围。helper反向依赖app形成环。dist.integrity 使用sha512；dist.tarball 是归档字节URL，本地文件是合成字节，不用于安装。/control 可移动tag、撤回根版本或损坏归档。所有包名都局限本地站点，不查询公网registry。

## 通用控制

`GET /inventory` 返回本来源当前目录，`GET /health` 检查存活，`GET /state` 查看来源状态。`POST /control` 接收JSON对象，仅在来源支持的字段范围内操作。每次创建服务重新读取 fixtures/source.json；控制用于复现来源演进，不是采集业务的实现接口。

服务使用随机本地端口，测试启动与关闭均由代码负责。没有真实个人资料、凭据或付费调用。
