# Immich 一键 Stack 与 Jobs 进度页集成设计

版本：2026-09-14
目标基线：Immich v3.1.0
关联项目：`I:\ai\immich-custom`、`I:\ai\immich-pair`
状态：Implemented and live verified；All-libraries V2 已完成 443/443 组真实 Stack

## 目标

在 Immich 管理端 Jobs/Queues 页面增加一张与现有任务卡片风格一致的“JPG + RAW Stack”卡片。管理员可以用一个按钮启动全库 Stack，设置执行并发数，并在同一页面看到扫描、准备、恢复、执行、失败和完成进度。

默认 `concurrency=32`，合法范围为 `1..64`。

本节点必须复用 `I:\ai\immich-pair` 已有 all-libraries V2 流程，不在 Immich fork 中复制配对或写入算法：

- `inspectAllLibraries()` / `writeAllLibrariesReport()`
- `prepareStackLiveBatchPlanV2()` / `writeStackLiveBatchPlanV2()`
- `deriveLiveBatchConfirmationV2()` / `assertLiveBatchStaticGateV2()`
- `runLiveStackBatchV2()`
- 现有 `PairRegistry`、deployment lease、intent-before-POST、zero-retry、receipt、reconcile 和 resume 语义

## 非目标

- 不重写同名同日期分组、JPG primary 选择、library binding 或 exclusion 规则。
- 不把 `immich-pair` 伪装成 Immich BullMQ 原生 Queue。
- 不让浏览器直接访问 runner、SQLite、plan、registry 或凭据。
- 不使用 `scripts/live-batch-progress.cjs` 或任何第二 SQLite reader 作为页面进度源。
- 不改变原有 Queue 的 Pause、Resume、Empty 或 concurrency 语义。
- 不在本节点加入自动回滚、强制中止或大规模 hardening。

## 架构

```text
Immich Web / Admin Jobs page
          │ Immich 登录会话
          ▼
Immich Server
GET  /api/jobs/stack
POST /api/jobs/stack
          │ loopback 私有调用 + control token
          ▼
immich-pair runner
          │
          └─ existing all-libraries V2 pipeline
                 ├─ PairRegistry 唯一活动连接
                 ├─ deployment lease
                 ├─ durable intent before POST
                 ├─ zero retry
                 └─ reconcile-first resume
```

职责边界：

- Web：显示状态、设置 concurrency、触发 start/resume，只调用 Immich Server。
- Immich Server：复用登录权限，绑定发起用户，代理固定 loopback runner；不读取 SQLite，不执行配对或 Stack 写入。
- runner：从只读 secret file 加载 API key，串接现有 V2，持有唯一活动 registry connection，并把 progress callback 写成独立原子状态快照。

## 凭据与访问边界

浏览器不提供 API key 输入框，也不在 `localStorage`、`sessionStorage`、IndexedDB、URL、请求体或前端 store 中保存 key。

runner 只从只读 secret file 读取 API key：

```text
IMMICH_PAIR_API_KEY_FILE=/run/secrets/immich_pair_api_key
```

Immich Server 与 runner 之间使用另一份独立 control token：

```http
X-Immich-Pair-Control: <server-side token>
```

runner 只监听 `127.0.0.1`，不暴露宿主机端口。推荐作为独立 Compose service 与 `immich-server` 共享 network namespace，使双方都通过 loopback 通信。

浏览器启动请求只包含：

```json
{
  "requestId": "canonical-uuid",
  "concurrency": 32
}
```

`ownerId` 必须由 Immich Server 从 `AuthDto.user.id` 提供，浏览器不能覆盖。runner 继续验证 API key 的 `/users/me` 与该 owner 一致。

## API 合同

浏览器到 Immich Server：

```http
GET  /api/jobs/stack
POST /api/jobs/stack
```

- GET 需要 `Permission.JobRead` 和管理员身份。
- POST 需要 `Permission.JobCreate` 和管理员身份。
- POST 校验 canonical request UUID 与整数 concurrency；默认 32、最小 1、最大 64。
- `202`：新任务或恢复已接受。
- `200`：相同 request ID 的幂等重复请求。
- `409`：已有其他活动任务。
- `422`：当前任务存在不可自动绕过的 BLOCKED/DRIFTED/UNATTRIBUTED 状态。
- `503`：runner 未配置或不可达。

Immich Server 到 runner：

```http
GET  /v1/health
GET  /v1/tasks/current
POST /v1/tasks
```

status 响应不得包含 API key、control token、confirmation、plan/registry 路径、资产路径或成员 ID 列表。

## 任务状态与进度

外部状态：

```ts
type PairStackTaskStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
type PairStackTaskPhase = 'INSPECTING' | 'PREPARING' | 'RECONCILING' | 'STACKING' | 'FINALIZING';
```

公开状态包含：

- task/request ID、状态、阶段、并发数；
- started/updated/finished 时间；
- determinate、current、total、percent、posts；
- prepared、dispatch-intent、acknowledged、uncertain、committed、blocked、unattributed、drifted 计数；
- 白名单化错误种类、错误码、简短信息和 `recoverable`。

进度规则：

- INSPECTING：第一版保持不确定进度，不为进度条重构扫描算法。
- PREPARING：显示已得到的候选数，POST 必须仍为 0。
- RECONCILING：只读恢复既有 operation，不重新 POST。
- STACKING：用现有 `StackLiveBatchProgress` 更新 committed/total、percent、posts 和 durable counts。
- FINALIZING：关闭 registry、释放 lease 和 credential 引用后才发布最终状态。

runner 状态通过临时文件、flush/fsync、atomic rename 写入独立 JSON。页面 GET 只读该快照或 runner 内存，不打开 `pairs.sqlite`，从源头避免外部 monitor 的 `database is locked`。

runner 重启时，旧 `RUNNING` 转为 `INTERRUPTED`；必须由管理员显式 Resume。Resume 保留原 plan 和原 concurrency，先执行 reconcile，非 `PREPARED` operation 不得重新 POST。

## Jobs 页面交互

在 `/admin/queues` 增加独立 `PairStackQueueCard`，复用：

- `QueueCardBadge.svelte`
- `QueueCardButton.svelte`
- `@immich/ui` 的 ProgressBar、Input、Icon、Badge
- 现有 Queue 卡片的间距、圆角、配色和 typography

不直接复用整个 `QueueCard.svelte`，因为它硬绑定 BullMQ 的 DTO 和 Pause/Resume/Empty/Start 语义。

页面状态：

- 无任务/已成功：concurrency 可编辑，按钮为 Stack。
- INSPECTING/PREPARING/STACKING：Active badge，进度可见，输入和按钮禁用。
- 可恢复 FAILED/INTERRUPTED：按钮为 Resume；沿用原 concurrency。
- 不可恢复 FAILED：显示需要人工处理，按钮禁用。
- SUCCEEDED：显示 committed/total、posts、完成时间，可重新发起 fresh inspect。

页面离开时必须停止 polling；runner 不可用不能影响原有 Queue 页面加载。

## 文件落点

`I:\ai\immich-pair`：

- 新增 `src/task-runner-contracts.ts`
- 新增 `src/task-state-store.ts`
- 新增 `src/all-libraries-task-runner.ts`
- 新增 `src/task-runner-server.ts`
- 新增 `src/task-runner-main.ts`
- 局部扩展 `src/stack-write-contracts.ts`、`src/stack-registration.ts`、`src/pair-registry.ts`
- 新增 `tests/all-libraries-job-critical.test.ts`
- 新增 runner script 与 `Dockerfile.runner`

默认不修改 pairing、all-libraries plan、write plan 和 transport 算法文件。只有现有入口确实缺少 callback 时，才允许对 `all-libraries-plan.ts` 做局部向后兼容扩展。

`I:\ai\immich-custom`：

- 新增 pair-stack job DTO、controller、service 及服务测试
- 通过现有生成流程更新 OpenAPI 与 SDK
- 新增 Web manager/service 和 `PairStackQueueCard.svelte`
- 局部修改 `/admin/queues` 页面挂载和 cleanup
- 增加 namespaced i18n 文案
- 最后新增独立 Compose overlay；不覆盖上游标准 Compose

## 最小冒烟测试

只增加三组直接证据：

1. 一键 V2 happy path：默认 concurrency 32，真实调用现有 inspect → prepare → run；每 pair 最多一次 POST，最终 SUCCEEDED，状态中无 secret/confirmation/path。
2. 失败与恢复：first anomaly 后不领取新 pair，已在途正常结束；重启转 INTERRUPTED；Resume 先 reconcile，原 operation POST 数不增加；status GET 不打开第二个 registry。
3. Immich API 与页面：管理员权限、owner 服务端绑定、1/64 接受、0/65 拒绝、RUNNING 禁用、recoverable 显示 Resume、runner unavailable 不破坏原 Queue、离页停止 polling。

## 实施顺序

1. 冻结 runner DTO、状态机和 secret-free 状态合同。
2. 在 `immich-pair` 增加薄 runner 编排与独立状态快照，复用现有 V2。
3. 增加 Immich Server 私有代理 API 和权限测试。
4. 增加 Jobs 页面卡片、按钮、进度与轻量组件测试。
5. 增加 Compose overlay，只做 health/status 联调。
6. 获得明确 live 授权后，用 concurrency 32 执行一次真实冒烟；否则只能声明合成 transport 验证完成。

## 完成条件

- Jobs 页面有一键 Stack 按钮和一致风格的任务卡片。
- concurrency 默认 32，三层限制为 1..64，Resume 不可改变原绑定值。
- 配对和 Stack 写入只由现有 all-libraries V2 实现执行。
- 浏览器、日志、状态 JSON、plan 和 SQLite 均无明文凭据。
- status 页面不打开 SQLite，不再存在外部 monitor 锁库路径。
- 同一 deployment 同时最多一个活动任务；重复点击幂等。
- runner 重启不会自动重发 POST。
- 旧 CLI critical tests 与新增 1–3 组 smoke/critical tests 通过。
- live 是否实际执行必须明确标记，不把未执行说成已验收。

## 待实施前确认的部署选择

Compose overlay 的实际启用方式、secret file 的最终宿主机路径以及是否替换当前正式 Immich image 都属于部署配置选择。实现代码和合成测试完成后，应先展示差异，再由用户明确确认后修改 `I:\ai\immich` 的运行配置。
