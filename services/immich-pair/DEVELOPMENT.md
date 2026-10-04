# immich-pair-readonly-cli

这是一个本地 TypeScript JPG/RAW 配对项目。A 阶段提供本地样本 dry-run；B0/B1 提供 Immich v3.1.0 的只读 wire adapter、metadata inventory、Asset detail 时间证据、纯函数配对、Stack observation 和 live-detail 只读入口；B2/B3 提供批量 mock 后端、隔离的单 pair `live-smoke`，以及必须从完整 MOCK evidence plan 派生独立计划的 `live-batch` 节点。

原有 `phase-b batch apply|resume` 仍只允许离线 mock，不能因新增 live 节点直接转成真实写入。2026-09-13 已对 `DSC03720.JPG + DSC03720.ARW` 完成一次真实 smoke；2026-09-15 又通过容器化 All-libraries V2 runner 完成 443/443 组真实 Stack，最终 `UNCERTAIN=0`、`BLOCKED=0`。V2 会把同一 owner、同一 library binding、相同规范化 stem 和相同本地拍摄秒的全部 JPG/JPEG/ARW/DNG 成员放入同一 Stack，并稳定选择 RAW 主图。凭据不写入 argv、日志、plan 或 SQLite；B1 manifest 和 MOCK plan 的只读/不可 live 语义保持不变。

设计、已确定边界和危险点：

1. [产品需求](docs/product-requirements.md)
2. [Phase B2/B3 批量设计与实现](docs/phase-b2-b3-stack-write-design.md)
3. [Phase B 当前决定](docs/phase-b-decisions-needed.md)
4. [Stack 写入危险点排障索引](docs/phase-b-stack-write-risks.md)
5. [Phase B 验收合同](docs/phase-b-acceptance.md)
6. [Phase B 离线交接记录](docs/phase-b-handoff.md)

## A 阶段本地 dry-run

```powershell
npm run cli -- scan --dry-run --config '<ABSOLUTE_CONFIG_JSON>'
```

配置必须明确 `mode=LOCAL_SAMPLE_DRY_RUN`、`ownerId`、`sampleRoot`、`reportDir` 和 `exiftoolPath`。允许的样本根仍为 `I:\photos\PHOTOMANAGER_TEST`；不得访问 `I:\photos\unmodified` 或 `/mnt/photos`。

## B0/B1 只读入口

```powershell
npm run cli -- phase-b protocol-check
npm run cli -- phase-b compat --offline --config '<NO_SECRET_CONFIG_JSON>'
npm run cli -- phase-b live-detail --config '<NO_SECRET_CONFIG_JSON>'
```

live-detail 只接受非 TTY stdin 的一行运行时 API key，且只做 compatibility、inventory 和 Asset detail GET；不会把 key 写入 argv、JSON、SQLite、日志或报告。

## B2/B3 完整批量 mock

离线 mock 批量固定 `concurrency=1`。计划只从完成的 B1 detail run 重验生成，唯一完整 JPG + ARW/DNG 进入 pair；歧义组继续排除。当前 fresh evidence MOCK plan 为 1,358 个候选 pair / 2,716 个资产，排除 443 个 ambiguous group，并排除已有 Stack 的 `DSC03720`；其 digest 为 `198c820685106046ba480c1155858550ffcd84837321ca74aa30f5068d273986`。该 MOCK plan 保持原样且不能直接交给 live-batch run。

```powershell
# 只读预览；必须提供绝对 source run 路径，不写文件、不联网
npm run cli -- phase-b batch preview `
  --config '<B1_CONFIG_JSON>' `
  --source-run '<B1_RUN_DIR>'

# 生成独立 batch plan，不修改 B1 run
npm run cli -- phase-b batch plan `
  --config '<B1_CONFIG_JSON>' `
  --source-run '<B1_RUN_DIR>' `
  --output '<NEW_PLAN_JSON>'

# 本节点唯一允许的 apply：明确 mock transport + 确认 token
npm run cli -- phase-b batch apply `
  --plan '<PLAN_JSON>' `
  --db 'I:\ai\immich-pair\data\pairs.sqlite' `
  --transport mock `
  --confirm LOCAL_MOCK_BATCH_APPLY

# resume 对 intent/unknown 只读 reconcile；新 PREPARED dispatch 仍需 token
npm run cli -- phase-b batch resume `
  --plan '<PLAN_JSON>' `
  --db 'I:\ai\immich-pair\data\pairs.sqlite' `
  --transport mock

# 若同一 plan 仍有 PREPARED pair，需要再次明确确认后继续 dispatch：
#   --confirm LOCAL_MOCK_BATCH_APPLY

# 只读 SQLite status；缺库不会自动创建替代数据库
npm run cli -- phase-b batch status --db 'I:\ai\immich-pair\data\pairs.sqlite'
```

也支持短别名 `phase-b preview|plan|apply|resume|status`。默认 SQLite 路径是 `I:\ai\immich-pair\data\pairs.sqlite`；SQLite 使用 Node 24 `node:sqlite`，不新增 npm 依赖。plan digest、双侧 asset claim、attempt quota、receipt、outcome、checkpoint 和 append-only journal 由 `PairRegistry` 持久化。CLI 的 mock 远端状态另存为同目录、按 plan digest 命名的 `pairs.sqlite.mock-server-<PLAN_DIGEST>.json`；它与客户端 receipt/operation 分离，使用临时文件、`fsync` 和原子 rename 更新，因此跨进程 resume 不会重置 Stack ID 或凭本地 receipt 猜测远端已写。

CLI 输出会明确 `network=not attempted` 或 `mock-only`。现有 batch 的 `--transport live` 继续在任何网络动作前拒绝，绝不由 `live-smoke` 放开。

## 独立单 pair live-smoke

先从 plan 中显式选定一个 `pairId`，再用纯静态 `prepare` 生成绑定的 `operationId` 和一次性 confirmation；该步骤不读凭据、不创建数据库、不访问网络：

```powershell
npm run cli -- phase-b live-smoke prepare --plan '<ABSOLUTE_PLAN_JSON>' --plan-digest '<FULL_PLAN_SHA256>' --pair-id '<EXPLICIT_PAIR_ID>'
```

未来执行必须逐项回填 prepare 输出，不能省略或默认选择，也不接受多 pair、`--max-operations` 或 argv 凭据；并且必须显式、精确提供 `--transport live`：

```powershell
$apiKey | npm run cli -- phase-b live-smoke run --plan '<ABSOLUTE_PLAN_JSON>' --plan-digest '<FULL_PLAN_SHA256>' --pair-id '<PAIR_ID>' --operation-id '<OPERATION_ID>' --confirm '<BOUND_CONFIRMATION>' --transport live --db 'I:\ai\immich-pair\data\pairs.sqlite'
```

只有精确的 `--transport live` 以及 plan path/digest、pair、operation 和 confirmation 的全部静态 gate 通过后，`run` 才从 non-TTY stdin 严格读取一行 `ApiKeyCredential`；缺失、`mock` 和大小写变体均 fail closed。live transport 仅暴露两个 Asset GET、必要的 Stack GET 和一次 `POST /api/stacks`；POST 零 retry、拒绝 redirect、只接受 201，body 固定为 `[jpg, raw]`。POST unknown 会先持久化 `UNCERTAIN`，随后在同次调用只读 reconcile；任何已有 intent/acknowledged/uncertain operation 重入也只读 reconcile，绝不重发 POST。

## 独立 full live-batch

prepare 从合法 READY MOCK evidence plan 派生新 schema、新文件和新 digest；它不打开 DB、不读 stdin、不 fetch：

```powershell
npm run cli -- phase-b live-batch prepare `
  --source-plan '<MOCK_PLAN_JSON>' --source-plan-digest '<FULL_MOCK_PLAN_DIGEST>' `
  --max-new-posts 20 --output '<NEW_LIVE_BATCH_PLAN_JSON>'
```

未来人工执行或恢复必须逐项回填 prepare 输出：

```powershell
$apiKey | npm run cli -- phase-b live-batch run `
  --plan '<LIVE_BATCH_PLAN_JSON>' --plan-digest '<FULL_LIVE_PLAN_DIGEST>' `
  --candidate-count '<EXACT_COUNT>' --deployment-id '<EXACT_DEPLOYMENT_ID>' `
  --max-new-posts 20 --confirm '<BOUND_CONFIRMATION>' --transport live --progress terminal `
  --db 'I:\ai\immich-pair\data\pairs.sqlite'

$apiKey | npm run cli -- phase-b live-batch resume `
  --plan '<LIVE_BATCH_PLAN_JSON>' --plan-digest '<FULL_LIVE_PLAN_DIGEST>' `
  --candidate-count '<EXACT_COUNT>' --deployment-id '<EXACT_DEPLOYMENT_ID>' `
  --max-new-posts 20 --confirm '<BOUND_CONFIRMATION>' --transport live --progress terminal `
  --db 'I:\ai\immich-pair\data\pairs.sqlite'
```

live-batch 固定 `concurrency=4`、无人工延迟、每对最多一次 POST、POST 零 retry。`--max-new-posts` 每次都必须显式提供正安全整数且不得超过 live plan 的完整 candidate count，并与 full live plan digest、candidate count、deployment ID 一起绑定进 confirmation；20 只是首轮真实 canary 的人工选择，不是产品硬上限，正式批处理可显式绑定完整 candidate count。达到 invocation limit 返回正常 `PAUSED` 且 `sliceCompleted=true`，已 COMMITTED 不计入新 POST，resume 必须重新提供完整绑定。可选的严格开关 `--progress terminal` 只向 stderr 输出无敏感信息的 committed/candidate、百分比、本次 posts、elapsed、rate、ETA 和最终状态；未提供时仍只有 stdout 的最终 JSON。正常成功路径每对是两次 fresh Asset GET、durable intent、一次 POST 和一次 receipt Stack GET，不重复读取两项 Asset。任一 pair 出现 read/drift/block/unknown/receipt/reconcile/registry 异常便停止领取新 pair，最多三个已在途 pair 自然结束并各自落盘。resume 先只读 reconcile 所有非 PREPARED/COMMITTED operation；任何一个未收敛为 COMMITTED 时不派发新 POST。deployment lease 防止两个 CLI 同时执行；向前 schema migration 保留 canonical pair operation、receipt、claims 和既有 `DSC03720` 记录。

## All-libraries nullable-library V2

V2 是独立 schema，不改写 V1 source/live plan、digest、receipt 或 registry 行。`LibraryBinding` 只有 `{kind:"UUID",value:<uuid>}` 与 `{kind:"NULL"}` 两种合法形态；API 字段缺失是 `ABSENT`，绝不等同 NULL。inspect 是唯一 evidence 网络阶段，API key 只从 non-TTY stdin 一行读取：

```powershell
$apiKey | npm run cli -- phase-b all-libraries inspect `
  --owner '<OWNER_UUID>' --library-scope all `
  --page-size 100 --detail-concurrency 4 `
  --report-dir 'I:\ai\immich-pair\reports\all-libraries-<RUN_ID>'
```

`--library-scope` 可为 `all|uuid|null`；`uuid` 必须额外提供 `--library-id <UUID>`，另外两种禁止该参数。`all` 先读取 `/users/me` 与 `/libraries`，再进行无 library filter 的严格分页 `/search/metadata`，只在相同 canonical binding 内分组，并对相关 JPG/JPEG/ARW/DNG fresh GET Asset detail。report dir、`source-plan-v2.json` 与 `summary.json` 都 exclusive-create；计数来自实时 evidence，不硬编码资产、group、candidate 或 exclusion 数量。已有 Stack 只成为 `CURRENT_STACK_UNMANAGED` exclusion，不生成 pair、operation 或 claim。

从 V2 source plan 离线派生 V2 live plan；prepare 不读 key、不打开 registry、不 fetch：

```powershell
npm run cli -- phase-b all-libraries prepare `
  --source-plan '<REPORT_DIR>\source-plan-v2.json' `
  --source-plan-digest '<FULL_SOURCE_DIGEST>' `
  --concurrency 4 --output '<NEW_LIVE_PLAN_V2.json>'
```

V2 完全没有 `--max-new-posts` 或分片概念。run/resume 必须显式提供 `--concurrency N`，范围 `1..64`，没有默认值；confirmation 绑定 full plan digest、完整 candidate count、deployment ID、library-scope digest 与 exact concurrency：

```powershell
$apiKey | npm run cli -- phase-b all-libraries run `
  --plan '<NEW_LIVE_PLAN_V2.json>' --plan-digest '<FULL_LIVE_DIGEST>' `
  --candidate-count '<EXACT_COUNT>' --deployment-id '<DEPLOYMENT_ID>' `
  --library-scope-digest '<LIBRARY_SCOPE_DIGEST>' --concurrency 4 `
  --confirm '<BOUND_CONFIRMATION>' --transport live --progress terminal `
  --db 'I:\ai\immich-pair\data\pairs.sqlite'

$apiKey | npm run cli -- phase-b all-libraries resume `
  --plan '<NEW_LIVE_PLAN_V2.json>' --plan-digest '<FULL_LIVE_DIGEST>' `
  --candidate-count '<EXACT_COUNT>' --deployment-id '<DEPLOYMENT_ID>' `
  --library-scope-digest '<LIBRARY_SCOPE_DIGEST>' --concurrency 4 `
  --confirm '<BOUND_CONFIRMATION>' --transport live --progress terminal `
  --db 'I:\ai\immich-pair\data\pairs.sqlite'
```

run 处理全部 PREPARED；resume 以同一 concurrency 并行执行只读 reconcile，全部收敛后继续处理全部 PREPARED，任何非 COMMITTED 恢复结果都会阻止新 POST。first anomaly 后不再领取任务，但最多 `concurrency-1` 个已经在途的任务会自然完成并 durable 落盘；因此高并发 64 意味着异常出现时最多仍有 63 个其他在途任务。每 pair 仍是 intent-before-POST、最多一次 POST、zero retry，非 PREPARED 重入永不重发。

## 测试

遵循 `docs/testing_strategy.md`：本节点只新增一个集中测试文件中的三条目标流程，不扩张理论安全矩阵或追求覆盖率。

```powershell
npm run typecheck
npm run test:critical
npm test
```

当前验证结果为 typecheck 通过、critical 36/36、全量 38/38。Node 24 会对 `node:sqlite` 打印实验性功能 warning；不影响测试结果。
