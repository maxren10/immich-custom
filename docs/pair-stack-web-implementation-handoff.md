# Pair-stack Web/OpenAPI 实施交接

基线：Immich `v3.1.0`，2026-09-14。后续 agent 先读本文档，再按具体问题补读源码；不要重复全量源码验证。开始前仍须检查 `git status`，保留其他 agent 的 Asset Viewer 删除补丁、Server 阶段3改动和设计文档。

## 文件职责

- `open-api/immich-openapi-specs.json`：由 Server build 和 `sync-open-api` 从 DTO/controller 生成的 OpenAPI 源文件；`/jobs/stack` 的 operationId 是 `getPairStackJob`、`startPairStackJob`，原生 `/stacks` 的 `getStack/createStack` 未被覆盖。
- `packages/sdk/src/fetch-client.ts`：由固定版本 `oazapfts@7.5.0` 生成的 TypeScript SDK；不要手写或复制其中的 DTO/API 方法。
- `server/src/controllers/pair-stack-job.controller.ts`：阶段3 controller 方法名为 `getPairStackJob`、`startPairStackJob`，避免与原生 Stack operationId 冲突。
- `server/src/services/pair-stack-job.service.ts`：阶段3 Server→runner adapter；严格接受 runner `PairStackTaskStatusSnapshot`，显式映射 `taskId→id`、`counts.posts→progress.posts`、可选时间/错误到公开 `null`，公开 `counts` 不含 `posts`，不透传敏感字段。
- `server/src/services/pair-stack-job.service.spec.ts`：包含精确 runner snapshot fixture 合同测试；验证省略 `finishedAt/error` 和 `posts` 映射。
- `web/src/lib/services/pair-stack-job.service.ts`：以别名调用生成 SDK 的 `getPairStackJob()` / `startPairStackJob()`；浏览器 POST body 只有 `requestId`、`concurrency`。
- `web/src/lib/managers/pair-stack-job-manager.svelte.ts`：全局 Svelte manager，维护公开 `PairStackJobTaskDto` 状态、runner 可用性和提交动作。
- `web/src/lib/managers/pair-stack-job-manager.svelte.spec.ts`：唯一新增 Web manager smoke，覆盖 polling 生命周期和 secret-free POST 参数。
- `web/src/routes/admin/queues/PairStackQueueCard.svelte`：独立 pair-stack 卡片，不伪造 BullMQ Queue；使用现有 `Badge`、`QueueCardButton`、`ProgressBar`、`Input` 和同类布局。显示阶段、`RUNNING/SUCCEEDED/FAILED/INTERRUPTED`、进度、committed/posts、错误和完成时间；按钮为 Stack/Resume。
- `web/src/routes/admin/queues/QueuePanel.svelte`：把独立卡片挂在原生 Queue 列表前，不改变原 Queue DTO 或命令语义。
- `web/src/routes/admin/queues/+page.svelte`：页面挂载/卸载 queue 与 pair-stack manager；卸载最后一个 pair-stack listener 会清理 polling interval。
- `web/src/routes/admin/queues/+page.ts`：只加载原生 queues；pair-stack 状态由客户端 manager 获取，因此 runner unavailable 不阻塞原 Queue 页面加载。
- `i18n/en.json`、`i18n/zh_Hans.json`、`i18n/zh_Hant.json`：新增 pair-stack 卡片、阶段/进度/错误/runner unavailable 文案；普通 Stack/Resume 按钮复用现有翻译。

## SDK 方法与 DTO

生成 SDK 当前提供：

- `getPairStackJob(opts?)`：`GET /jobs/stack`，返回 `PairStackJobResponseDto`。
- `startPairStackJob({ pairStackJobCreateDto }, opts?)`：`POST /jobs/stack`，使用 `PairStackJobCreateDto`。
- `PairStackJobResponseDto`、`PairStackJobTaskDto`、`PairStackJobProgressDto`、`PairStackJobCountsDto`、`PairStackJobErrorDto`、`PairStackJobStatus`、`PairStackJobPhase`。

服务端仍负责从登录态绑定 `ownerId` 并发送 control token；Web 不接触 API key、control token、ownerId、runner URL、plan/registry/path 或 SQLite。

## Manager polling 合同

`pairStackJobManager.listen()` 立即 GET 一次，并在有 listener 时每 2 秒 GET；它内部吞掉 runner unavailable，使原生 Queue 不受影响。返回的 cleanup 函数幂等；最后一个 listener 卸载时清理 interval。`stack()` 生成 canonical UUID，`resume(task)` 复用服务端返回的原 `requestId` 与 `concurrency`。RUNNING 时卡片禁用按钮和 concurrency 输入；新任务默认 `32`，前端约束 `1..64`，Server/runner 仍做最终校验。

## 测试与生成结果

已执行并通过：

```powershell
pnpm --filter immich build
node ./dist/bin/sync-open-api.js                 # cwd: server
npx --yes oazapfts@7.5.0 --optimistic --argumentStyle=object --useEnumType --allSchemas open-api/immich-openapi-specs.json packages/sdk/src/fetch-client.ts
pnpm --filter @immich/sdk build
pnpm exec vitest --config test/vitest.config.mjs run src/services/pair-stack-job.service.spec.ts src/controllers/pair-stack-job.controller.spec.ts src/repositories/config.repository.spec.ts  # cwd: server; 3 files / 51 tests
pnpm run check                                      # cwd: server
pnpm run lint                                       # cwd: server
pnpm exec vitest run src/lib/managers/pair-stack-job-manager.svelte.spec.ts  # cwd: web; 1 file / 1 test
pnpm run check:typescript                            # cwd: web
pnpm run lint                                       # cwd: web
pnpm exec svelte-check --no-tsconfig --compiler-warnings 'state_referenced_locally:ignore'  # cwd: web; 0 errors / 0 warnings
pnpm exec prettier --check ...                       # cwd: web; all checked files formatted
```

OpenAPI 还做了 JSON operationId 唯一性检查：`DUPLICATE_OPERATION_IDS=NONE`；定向结果为 `/jobs/stack → getPairStackJob/startPairStackJob`，`/stacks → createStack/getStack`。严格的 `pnpm run check:svelte` 在仓库既有 `38 files / 56 state_referenced_locally warnings` 下因 `--fail-on-warnings` 失败；本次新增文件没有该 warning，忽略该既有 warning 的 Svelte 检查为 0 errors/0 warnings。

## 未完成边界

本交付没有修改 `I:\ai\immich-pair` runner、Compose/deployment、正式 image、环境文件或 secret，也没有执行 live Stack、真实库扫描或 live recovery。Compose overlay、secret file 最终路径、正式 image 替换以及 live smoke 仍需用户明确确认后另行处理；本轮未提交、未推送。
