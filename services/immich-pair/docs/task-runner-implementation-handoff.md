# Task Runner 阶段 1/2 实施交接

后续 agent 请先读本文档，再按具体问题补读下列目标文件；无需重新做全量源码审计。工作树已有其他用户改动，继续保留，不回退、不提交、不推送。

## 本轮文件与职责

- `src/task-runner-contracts.ts`：runner DTO、状态/阶段、公开计数和错误白名单；POST 请求严格校验；`concurrency` 默认 32、范围 `1..64`；公开状态不含 owner、凭据、confirmation、plan/registry/资产路径或成员列表。
- `src/task-state-store.ts`：单一当前任务的独立 JSON 快照；临时文件 + `fsync` + atomic rename；live plan 按 taskId 单独持久化；启动时把遗留 `RUNNING` 转为可恢复 `INTERRUPTED`；status 读取不打开 SQLite。
- `src/all-libraries-task-runner.ts`：薄编排层；新任务执行 inspect → prepare → reconcile → stack → finalize；已有 plan 的 Resume 直接走 V2 reconcile-first；清理 runtime、关闭 registry 后才发布终态。
- `src/task-runner-server.ts`：固定监听 `127.0.0.1` 的私有 HTTP server；control token 校验、请求体大小限制和安全错误映射。
- `src/task-runner-main.ts`：生产组合入口；API key 只从 `IMMICH_PAIR_API_KEY_FILE` 读取；control token 优先从 `IMMICH_PAIR_CONTROL_TOKEN_FILE` 读取，否则使用 `IMMICH_PAIR_CONTROL_TOKEN`；两种来源都只接受一行非空内容；Windows 默认状态文件/registry 仍为 `I:\ai\immich-pair\data\task-state.json`、`I:\ai\immich-pair\data\pairs.sqlite`，非 Windows 默认分别为 `/data/task-state.json`、`/data/pairs.sqlite`。
- `src/pair-registry.ts`：Windows 继续使用原有安全路径与 reparse/junction guard；非 Windows 接受绝对 POSIX 路径且 basename 严格为 `pairs.sqlite`，对现有路径组件和目标使用 `lstat` 拒绝 symlink（POSIX 没有 Windows junction/reparse 的直接等价物）。
- `tests/all-libraries-job-critical.test.ts`：默认并发/happy path/幂等/脱敏状态，以及中断、acknowledged 恢复和零重复 POST 的两组 critical 测试。
- `tests/task-runner-main-critical.test.ts`：入口 secret 优先级、单行校验、API key file-only，以及 Linux POSIX registry 路径的最小回归；POSIX 用例在 Windows 主机跳过，在 runner Linux 容器中执行。
- `Dockerfile.runner` / `Dockerfile.runner.dockerignore`：Node 24 多阶段构建；构建阶段使用现有 npm/tsc，运行阶段只带编译后的 `dist/src`，以非 root `node` 用户运行并准备可写 `/data`。
- `src/stack-write-contracts.ts`：向后兼容地为 `StackLiveBatchProgress` 增加可选 `phase`；V1 事件形状不变。
- `src/stack-registration.ts`：V2 progress 发出 `RECONCILING`、`STACKING`；没有改变现有写入、receipt 或 reconcile 算法。
- `package.json`：新增 `npm run task-runner`，并把新测试加入 `test:critical`；保留此前已有脚本改动。

## Runner HTTP 合同

默认地址：`http://127.0.0.1:2284`；端口可由 `IMMICH_PAIR_RUNNER_PORT` 设置。所有路由要求 `X-Immich-Pair-Control`：

- `GET /v1/health`
- `GET /v1/tasks/current`，返回 `{ "task": <公开状态或 null> }`
- `POST /v1/tasks`，请求只允许 `{ "requestId": "canonical-uuid", "ownerId": "canonical-uuid", "concurrency"?: 1..64 }`

POST 返回：新任务/恢复为 `202`；同 requestId 幂等重复为 `200`；另一任务活动中为 `409`；非法请求、恢复时改变 concurrency、owner 不符或不可恢复状态为 `422`。认证失败为 `401`，过大/非法 JSON 请求体为 `413`/`400`。

## 状态、恢复与并发合同

- 状态：`RUNNING | SUCCEEDED | FAILED | INTERRUPTED`。
- 阶段：`INSPECTING | PREPARING | RECONCILING | STACKING | FINALIZING`。
- 同一 runner 同时只接受一个活动任务；同 requestId 重复调用幂等。
- fresh 请求未提供 concurrency 时使用 32；只能为整数 `1..64`。
- Resume 沿用原 taskId、owner 和 concurrency；请求不能改变原 concurrency。
- 重启后旧 `RUNNING` 先持久化为 `INTERRUPTED`，必须显式 POST 同 requestId 恢复。
- 已存在 live plan 时，恢复打开既有 registry 并首先调用现有 V2 reconcile；非 `PREPARED` operation 不会再次 POST。
- 若崩溃发生在 plan 产生前，Resume 可重新 inspect；此时尚无 operation/POST 可恢复。
- 公开 status 的 `posts` 取 registry 累计 attempts，恢复后不会被本次调用的零 POST 覆盖。

## 现有 V2 复用点

runner 直接调用以下现有入口，不复制 pairing、plan、write 或恢复算法：

- `inspectAllLibraries()`
- `deriveStackLiveBatchPlanV2()` / 现有 V2 plan validator
- `deriveLiveBatchConfirmationV2()` / `assertLiveBatchStaticGateV2()`
- `runLiveStackBatchV2()`
- `PairRegistry`、deployment lease、intent-before-POST、zero-retry、receipt、reconcile/resume
- `PhaseBReadClient` 和 `LiveStackWriteTransport`

GET status 只读 runner 内存/独立状态快照，不新建第二个 `PairRegistry` 或 SQLite monitor。

## 容器运行配置

- 构建：`docker build -f Dockerfile.runner -t immich-pair-task-runner:local .`。
- 运行阶段通过 `IMMICH_PAIR_API_KEY_FILE=/run/secrets/api-key` 提供 API key；不存在 API key 环境变量回退，`IMMICH_PAIR_API_KEY` 不被读取。
- control token 可用 `IMMICH_PAIR_CONTROL_TOKEN_FILE=/run/secrets/control-token`，文件存在时优先于 `IMMICH_PAIR_CONTROL_TOKEN`；定义了空的 file path 或文件内容不是一行非空 secret 时直接失败，不回退到 env。
- Dockerfile 设置 `IMMICH_PAIR_TASK_STATE_PATH=/data/task-state.json`、`IMMICH_PAIR_REGISTRY_PATH=/data/pairs.sqlite`，并将 `/data` 交给非 root `node` 用户（当前镜像 UID `1000`）。
- server 仍固定监听容器内 `127.0.0.1:2284`；本节点不新增 Compose overlay、外部网络暴露或宿主机到容器的 loopback 转发。容器内 health 可验证，正式联调仍需单独设计/授权。

## 已验证

- `npm run typecheck`：通过。
- `node --test dist/tests/all-libraries-job-critical.test.js`：2/2 通过。
- `node --test dist/tests/phase-b-write-critical.test.js`：3/3 通过。
- 两个目标文件合跑：5/5 通过。
- `npm run test:critical`：38/38 通过。
- `npm run build; node --test dist/tests/task-runner-main-critical.test.js`（Windows 主机）：1 通过、1 个 Linux-only 用例跳过、0 失败。
- `docker run ... --test /workspace/dist/tests/task-runner-main-critical.test.js`（Node 24 Linux）：2/2 通过，含 POSIX registry 回归。
- `npm test`：41/41 通过，1 个 Linux-only POSIX registry 用例在 Windows 主机跳过（总计 42 个，0 失败）。
- `docker build -f Dockerfile.runner -t immich-pair-task-runner:local .`：通过；最终镜像内 Node `v24.21.0` 暴露 `node:sqlite.DatabaseSync`。
- 最终镜像容器内 probe：health `200`，UID `1000`，`/data` 可写，`/data/pairs.sqlite` 可创建；未执行任务 POST。
- `git diff --check`：通过；本节点新增/修改文件另以 `rg` 检查无行尾空白。

测试仅使用 synthetic gateway、mock transport 和临时 SQLite；没有调用真实 Immich、读取真实 API key、发送真实 Stack POST 或访问照片。

## 尚未完成/不在本节点

- `I:\ai\immich-custom` 的 Immich Server controller/service/DTO、权限与 owner 服务端绑定。
- OpenAPI/SDK 更新、Jobs 页面卡片、polling cleanup 和前端测试。
- Compose overlay、正式 secret 挂载/部署启用、容器外网络暴露和健康联调。
- 真实 Immich/API key/live POST 验收、Hardening/Release、完整 fault matrix、自动回滚或强制中止。

继续实施前先检查当前工作树；部署、secret 路径、Compose 和真实 live 写入仍需用户明确授权。

## 2026-09-14 手动解栈后再次建栈修复

- 现象：已经由 Runner 成功管理的 JPG+RAW pair 被用户在 Immich 中手动解栈后，再次执行全库 Stack 会在写入前以 `operation-mismatch` 失败；任务显示 `FINALIZING 0/1`、`posts=0`。
- 根因：`pairId` 对同一组资产保持稳定，但 Registry 将第一次 COMMITTED operation 的 evidence/request digest 永久绑定；手动解栈会更新资产证据，因此新计划无法复用旧 operation。
- `src/pair-registry.ts`：新增追加式 `operation_history` 表。仅当旧 pair 为 `REGISTERED`、旧 operation 为 `COMMITTED`、资产/owner/pair 绑定仍一致且新计划明确为 `NO_STACK` 时，归档旧 operation 并重新置为 `PREPARED`；其他 mismatch 继续拒绝。重准备写入审计事件 `REPREPARE_AFTER_MANUAL_UNSTACK`。
- `tests/phase-b-write-critical.test.ts`：新增“首次建栈成功 → 模拟手动解栈 → 同一 pair 再次建栈”的最小回归，验证第二轮只产生一个 POST、最终 COMMITTED，且旧 operation 有一条历史归档。
- 定向回归：`phase-b-write-critical` 与 `task-runner-main-critical` 合跑结果为 5 通过、0 失败、1 个 Windows 上的 Linux-only 用例跳过。
- 已重建并部署 `immich-pair-task-runner:local`（镜像 ID `sha256:a4c386f23be03a0c58c16c5095e1483a3a7141ca6161b4c86136396907e682bc`），仅 force-recreate `immich_pair_runner`；`immich_server` 未重启且保持 healthy。
- 真实复测：请求 `59786b11-2105-4143-b8aa-6b251e88f3c4`，concurrency 32，最终 `SUCCEEDED / 1 of 1 / posts=1 / committed=1`。`DSC07002.JPG` 与 `DSC07002.ARW` 均属于 Stack `516cd131-e04a-4ca0-a793-953c03c1e296`，JPG 为 primary；Registry 中该 pair 的历史归档数为 1。
