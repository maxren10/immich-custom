# Pair Stack Server 阶段 3 实施交接

基线：Immich `v3.1.0`，`HEAD 8aa95c6`。本轮仅实现 Immich Server 代理 API。

> 后续 agent 先读本文档和 `docs/custom-stack-job-integration.md`，再按具体问题补读下列文件；不需要重复全量源码审计。开始前先检查 `git status`，保留现有 Asset Viewer 删除补丁及他人改动。

## 文件清单

新增：

- `server/src/dtos/pair-stack-job.dto.ts`：浏览器请求、公开任务状态、进度、计数及白名单错误 DTO。
- `server/src/controllers/pair-stack-job.controller.ts`：挂载 `GET/POST /api/jobs/stack`，设置权限和 POST 动态状态码。
- `server/src/services/pair-stack-job.service.ts`：调用 loopback runner、绑定 owner、过滤响应、映射错误。
- `server/src/controllers/pair-stack-job.controller.spec.ts`：路由认证、默认/边界 concurrency、ownerId 隔离、`200/202` 测试。
- `server/src/services/pair-stack-job.service.spec.ts`：内部请求、secret-free 响应、owner 绑定、幂等及 runner 异常测试。

修改：

- `server/src/controllers/index.ts`：注册 `PairStackJobController`。
- `server/src/services/index.ts`：注册 `PairStackJobService`。
- `server/src/dtos/env.dto.ts`：声明 runner URL 和 control token 环境配置。
- `server/src/repositories/config.repository.ts`：读取配置/secret file并校验 loopback URL。
- `server/src/repositories/config.repository.spec.ts`：配置默认值、loopback 接受和非 loopback 拒绝测试。
- `server/test/repositories/config.repository.mock.ts`：补充 `pairStack` 测试配置。

## 浏览器 API 合同

`GET /api/jobs/stack`

- 管理员且需要 `Permission.JobRead`。
- 成功返回 `{ task: PairStackJobTask | null }`。
- runner current endpoint 返回 `404` 时映射为 `{ task: null }`。
- runner 未配置、不可达或响应 schema 非法时返回 `503 / PAIR_STACK_RUNNER_UNAVAILABLE`。

`POST /api/jobs/stack`

- 管理员且需要 `Permission.JobCreate`。
- 浏览器 body 只有 `{ requestId, concurrency? }`；`requestId` 必须是 canonical UUID，`concurrency` 默认 `32`，仅允许整数 `1..64`。
- `ownerId` 不在浏览器 DTO 中，只由 `AuthDto.user.id` 写入 runner 请求；浏览器附加的 `ownerId` 会被 DTO 丢弃。
- runner `202` 原样映射为已接受，runner `200` 原样映射为相同 request ID 的幂等结果。
- runner `409` → `PAIR_STACK_ALREADY_RUNNING`；`422` → `PAIR_STACK_TASK_BLOCKED`；`401/403` → `503 / PAIR_STACK_RUNNER_REJECTED`；其余失败 → scoped `503`。

## Runner 内部接口与安全边界

Server 只调用：

- `GET /v1/health`
- `GET /v1/tasks/current`
- `POST /v1/tasks`，body 为 `{ requestId, ownerId, concurrency }`

配置项：

- `IMMICH_PAIR_RUNNER_URL`
- `IMMICH_PAIR_CONTROL_TOKEN`
- `IMMICH_PAIR_CONTROL_TOKEN_FILE`（优先于 token 环境变量）

边界：

- URL 只允许 credential-free HTTP(S) 的 `127.0.0.0/8` 或 `::1`，禁止非 loopback、用户名/密码、query 和 hash。
- control token 只从服务端配置或 secret file 读取，通过 `X-Immich-Pair-Control` 内部 header 发送；不进入浏览器请求体、响应或本 service 日志。
- secret file 不可读或为空按未配置处理，仅使本代理 API 返回 `503`，不影响其他 Jobs。
- 内部请求超时 `5000ms`，并使用 `redirect: 'error'` 防止重定向泄漏 token。
- runner 响应经过 DTO 投影；不会公开 ownerId、凭据、confirmation、plan/registry/资产路径或成员 ID 列表，也不会透传 runner 原始错误 message。

## 公开状态合同

- `status`：`RUNNING | SUCCEEDED | FAILED | INTERRUPTED`
- `phase`：`INSPECTING | PREPARING | RECONCILING | STACKING | FINALIZING`
- 标识/时间：`id`、`requestId`、`concurrency`、`startedAt`、`updatedAt`、`finishedAt`
- `progress`：`determinate`、`current`、`total`、`percent`、`posts`
- `counts`：`prepared`、`dispatchIntent`、`acknowledged`、`uncertain`、`committed`、`blocked`、`unattributed`、`drifted`
- 错误只映射为固定 kind/code/message/recoverable：`BLOCKED`、`DRIFTED`、`UNATTRIBUTED`、`RUNNER_UNAVAILABLE`、`RUNNER_REJECTED` 或兜底 `FAILED`。

## 验证证据

首次测试前因 workspace 的 `@immich/plugin-sdk` 构建入口缺失，按仓库脚本生成了被 Git 忽略的依赖产物：

```powershell
pnpm --filter @immich/sdk build
pnpm --filter @immich/plugin-sdk build
```

在 `I:\ai\immich-custom\server` 执行：

```powershell
pnpm exec vitest --config test/vitest.config.mjs run src/services/pair-stack-job.service.spec.ts src/controllers/pair-stack-job.controller.spec.ts src/repositories/config.repository.spec.ts
pnpm run check
pnpm run lint
```

结果：3 个测试文件、50 个测试通过；`tsc --noEmit` 通过；server 全量 lint 通过。`git diff --check` 无空白错误，仅有 Windows LF/CRLF 提示。

## 尚未完成与禁止扩展

- 本轮 Server 实现未把 OpenAPI/SDK 生成纳入完成项。当前工作树另有 `open-api/immich-openapi-specs.json` 和 `packages/sdk/src/fetch-client.ts` 并行改动，归属及完整性未经本轮验证；后续先定向检查其 diff，不要覆盖或据此跳过正式生成验证。
- 未实现或修改 Web UI、Jobs 卡片、polling、i18n。
- 未实现 runner、pairing 或 Stack 算法，未读取 SQLite，未进行 live Stack。
- 未修改 Compose、部署、正式 image、环境文件或 secret 文件。
- 未提交、未推送。

继续阶段 3 时只需针对上述 server 文件和失败证据补读；进入 OpenAPI、Web、runner 或部署属于后续阶段，必须保持相应范围和授权边界。
