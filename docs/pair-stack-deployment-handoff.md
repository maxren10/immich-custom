# Pair Stack 容器化与部署交接

基线：Immich `v3.1.0`，源码 commit `8aa95c67470a02a8ddedf03c2e52963af33065ff`。本文件只记录阶段 5 的镜像与 Compose 集成；功能合同分别见 `pair-stack-server-implementation-handoff.md`、`pair-stack-web-implementation-handoff.md` 和 `I:\ai\immich-pair\docs\task-runner-implementation-handoff.md`。

## 本节点文件

- `docker/docker-compose.pair-stack.yml`：独立 Compose overlay；为 `immich-server` 构建/指定本地定制镜像，并增加共享 loopback namespace 的 `immich-pair-runner`。不覆盖上游或当前线上 Compose。
- `docs/pair-stack-deployment-handoff.md`：本交接文档。

## 网络与 secret 合同

- runner 使用 `network_mode: service:immich-server`，不发布宿主机端口；两端仅通过 `http://127.0.0.1:2284` 通信。
- runner 在共享 namespace 内继续通过固定 `http://127.0.0.1:2283` 调用 Immich，因此无需扩展现有 transport 的 origin allowlist。
- API key 只挂载到 runner 的 `/run/secrets/immich_pair_api_key`。
- control token 文件同时只读挂载到 Server 与 runner 的 `/run/secrets/immich_pair_control_token`。
- runner 状态、live plan 与唯一 SQLite registry 位于可写 `/data`，页面轮询不读取 SQLite。

### 已定位的本地 Immich API 凭据

- 宿主机凭据目录：`C:\Users\15372\.immich-pair-secrets`
- 已发现凭据文件：`C:\Users\15372\.immich-pair-secrets\api-key.dpapi`
- 该文件是 Windows DPAPI 保护的凭据文件；本文档只记录位置，不记录、读取或展示其中的 API key 内容。
- 当前 Linux runner 的 `IMMICH_PAIR_API_KEY_FILE` 合同要求挂载一行非空的可用 API key，不能直接把 DPAPI 密文文件当作明文 key 使用。正式部署前需要增加宿主机解密/临时 secret 交接步骤，或为 runner 增加受控的 DPAPI 凭据桥接；具体方式需要单独确认。

overlay 要求调用方显式提供以下宿主机路径；模板不替部署者选择或创建 secret：

- `IMMICH_PAIR_API_KEY_FILE_HOST`
- `IMMICH_PAIR_CONTROL_TOKEN_FILE_HOST`
- `IMMICH_PAIR_DATA_LOCATION`

镜像标签可选覆盖：

- `IMMICH_PAIR_IMMICH_IMAGE`，默认 `immich-server-custom:v3.1.0-pair-stack`
- `IMMICH_PAIR_RUNNER_IMAGE`，默认 `immich-pair-task-runner:local`

## 运行入口与日常核验

主 agent 另已新增并实测 `I:\ai\immich\pair-stack-compose.ps1`；本节点不编辑该脚本。脚本固定组合 base Compose 与本 overlay：

- base：`I:\ai\immich\docker-compose.yml`
- overlay：`I:\ai\immich-custom\docker\docker-compose.pair-stack.yml`
- 脚本只保存 runtime secret 路径和 data 路径，不保存或输出任何 secret 内容。

推荐的日常只读状态检查命令：

```powershell
& 'I:\ai\immich\pair-stack-compose.ps1' ps
```

该命令已由主 agent 实测成功，显示 custom Server/runner 在运行且 Server healthy。

## 合并方式

当前目录布局假定三个同级目录：`I:\ai\immich`、`I:\ai\immich-custom`、`I:\ai\immich-pair`。为保证 overlay 中 build context 始终相对 `I:\ai\immich` 解析，预览或启用时必须显式设置 project directory：

```powershell
docker compose `
  --project-directory 'I:\ai\immich' `
  -f 'I:\ai\immich\docker-compose.yml' `
  -f 'I:\ai\immich-custom\docker\docker-compose.pair-stack.yml' `
  config
```

只有在用户确认三个宿主机路径和正式镜像切换后，才执行带同样参数的 `build` / `up -d`。不要复制覆盖 `I:\ai\immich\docker-compose.yml`。

## 已验证

- overlay 已与当前 `I:\ai\immich\docker-compose.yml` 合并执行 `docker compose config`；两个 build context 分别解析为 `I:\ai\immich-custom` 和 `I:\ai\immich-pair`，runner 自动依赖 Server 且没有宿主机端口映射。
- `server/Dockerfile` 已成功构建 `immich-server-custom:v3.1.0-pair-stack`，本地镜像 ID 为 `sha256:e8fd98ffb5e2abbc9ff04be08350d61e5bf4d249d85da79308667b36f31b81a2`。
- `I:\ai\immich-pair\Dockerfile.runner` 已成功构建 `immich-pair-task-runner:local`，本地镜像 ID 为 `sha256:381bdcdf4c3de65e0ea035e19792c0be0b681595594c1a5ea84a6de5c8dd0b65`；运行用户为非 root `node`。容器内 health probe 为 `200`，`/data` 可写且 POSIX registry 回归通过，未发送任务 POST。
- 已直接检查构建产物：Server dist 包含 pair-stack DTO/service，Web 静态产物包含 pair-stack Jobs 卡片文案。
- 前一阶段曾确认 `immich_server` 使用官方 `ghcr.io/immich-app/immich-server:v3`；该条是历史基线，不代表本次收尾快照。

## 收尾只读核验（2026-09-14）

本节点在等待跨过 healthcheck 周期后，仅执行只读 `docker ps`、限定字段 `docker inspect` 和最小日志核验；没有读取容器 Env、secret 文件内容或任何 secret 值，也没有修改、重启或停止容器。

- `immich_server`：`immich-server-custom:v3.1.0-pair-stack`，状态 `running`，Docker health `healthy`；启动时间为 `2026-09-14T09:22:32.90408537Z`。
- `immich_pair_runner`：`immich-pair-task-runner:local`，状态 `running`；该容器当前未声明 Docker healthcheck，因此本文只记录运行状态，不把它误写为 Docker `healthy`。
- `immich_postgres`：`ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0`，状态 `running (healthy)`；`immich_redis`：`valkey/valkey:9`，状态 `running (healthy)`；`immich_machine_learning`：`ghcr.io/immich-app/immich-machine-learning:v3`，状态 `running (healthy)`。三者均未被 pair-stack 定制镜像替换。
- Server health probe 在 UTC `09:25:03`、`09:25:33`、`09:26:03`、`09:26:33`、`09:27:03` 均 `exit=0`；连续成功后状态仍为 `healthy`。
- 最近 Server 日志的最小过滤结果显示正常监听 `2283` 以及 ML healthy；没有把日志当作 secret 来源。runner 最近日志未匹配到本次过滤的 `error`/`fatal`/`health`/`task` 关键词。
- 容器挂载核对：Server 与 runner 的 control token runtime 文件均以 `RW=false` 挂载到 `/run/secrets/immich_pair_control_token`；runner 的 API key runtime 文件以 `RW=false` 挂载到 `/run/secrets/immich_pair_api_key`。本文只记录挂载用途和路径，不记录或展示内容。
- DPAPI 源路径仍为 `C:\Users\15372\.immich-pair-secrets\api-key.dpapi`；该路径仅用于标识受 Windows DPAPI 保护的源文件。runtime secret 是 Docker 的只读挂载输入，不在本文记录其内容。
- 主 agent 已处理首次部署时 `server/bin/immich-healthcheck` 的 CRLF `bash\r` 问题：增加 `.gitattributes` 规则、规范化为 LF，并重建、强制重建 Server/runner；上述连续 healthcheck 成功是处理后的实际证据。

## 回退边界

- 回退边界是 pair-stack 的部署层：custom Server 镜像与 pair runner 作为一组撤出，base Compose 中的官方 Server 配置恢复；base Compose 文件本身不被 overlay 覆盖。
- 官方 Postgres、Valkey/Redis、ML 及其数据不属于 custom Server/runner 镜像回退范围；照片库、Postgres 数据目录、runner 的 `I:\ai\immich-pair\data` 和 runtime secret 文件均应保留并单独核对。
- 回退不等于数据层回滚，也不自动撤销已经产生的任务、SQLite registry 或数据库变化。任何实际回退前都必须由操作者确认数据兼容性与恢复点；本节点没有执行回退。
- 本次收尾未执行 live Stack 操作：没有执行 `build`、`up`、`down`、`restart` 或 `stop`，也没有发送真实 pair task；当前运行状态仅由只读核验及主 agent 已实测的脚本 `ps` 命令记录。

## 尚未完成

- 尚未选择或创建 control token 文件。
- 已确认 DPAPI 凭据源文件位置，但尚未确定把解密后的 API key 安全交给 Linux runner 的方式，也尚未确认 runner data 的最终宿主机路径。
- 尚未执行真实 pair task；live Stack 的启动/重建/回退操作不属于本次收尾范围。
- runner Dockerfile、Linux registry 路径兼容和其测试由 `I:\ai\immich-pair` 节点完成，并记录到该项目交接文档。
