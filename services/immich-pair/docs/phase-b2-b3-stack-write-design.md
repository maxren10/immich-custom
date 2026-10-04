# Phase B2/B3：本地单用户批量 Immich Stack 设计与实现

版本：2026-09-12
状态：ALL_LIBRARIES_V2_LIVE_VERIFIED；已完成 443/443 组真实 Stack
适用版本：Immich Server 3.1.0
运行边界：`LOCAL_SINGLE_USER_SINGLE_WRITER`、纯本地、单进程 writer、任务并发 1–64；当前部署为 32，Stack POST 门控为 4
代码范围：后端/CLI/SQLite 注册表；不含前端、原图修改、Asset 删除、Stack 删除、Docker/Postgres/DPAPI/key

## 1. 当前结论

本节点已经实现完整的批量 plan/apply/resume/status 流程。它从已完成的 B1 Asset detail 只读产物生成独立 batch plan，并按 pair 串行执行：

```text
B1 manifest/detail evidence
        │ 只读重验、重新配对、排除歧义组
        ▼
preview / plan ──> B2_B3_STACK_BATCH_PLAN_V1
        │
        ▼
SQLite prepare + claims + checkpoint
        │
        ▼
每对：fresh read ──> durable DISPATCH_INTENT ──> 一次 POST ──> 独立 read ──> commit
        │                                                        │
        └────────已有 intent/未知结果只走 read-only reconcile─────┘
```

现有 `phase-b batch apply|resume` 可执行 transport 仍只有离线 `MOCK`，`--transport live` 会在任何网络动作前拒绝。单 pair `live-smoke` 保持隔离；full `live-batch` 使用独立 `B2_B3_STACK_LIVE_BATCH_PLAN_V1`，只能由已通过完整 digest/shape/gate 校验的 READY MOCK evidence plan 派生，不能复制 MOCK JSON 改字段后直接 live。live-batch 静态 gate 全部通过后才打开 registry、从 non-TTY stdin 读取一行运行时凭据并构造 transport。本节点只以注入 fake fetch 验证，没有读取真实 key 或发送真实请求。

批量不是 canary-only 绕路：实现会处理 plan 中所有唯一、完整、当前无 Stack、属于同一 owner 和当前 explicit library scope 的 pair。fresh evidence MOCK plan 固定为 1,358 个 candidate pair / 2,716 个资产、443 个 ambiguous group；`DSC03720` 因 current Stack 被排除。source digest 为 `198c820685106046ba480c1155858550ffcd84837321ca74aa30f5068d273986`，源文件保持不变。

## 2. 不可变边界与已核实 wire facts

### 2.1 B1 来源保持只读

- B1 `manifest.json`、`run.json`、`detail-assets.json`、`detail-outcomes.json`、`pairing.json` 和 `final-summary.json` 只读打开并校验字节 SHA-256。
- plan 保存 source run id、manifest digest、source snapshot digest 和全部输入文件指纹；不会修改、补写或把 B1 的 `canBeUsedForStackWrite` 改为 true。
- plan 的 `executable`、`canBeUsedForStackWrite`、`snapshotGuaranteed` 始终为 `false`。真正的 runtime capability 只能由 coordinator 在 fresh read、授权、SQLite intent 全部成功后构造。
- 当前 evidence mode 是 `IMMICH_ASSET_DETAIL`：不访问 `I:\photos\unmodified`、`/mnt/photos` 或任何原图/download endpoint。
- uniqueness scope 是 `EXPLICIT_LIBRARIES`：plan 不把范围外资产不存在当作事实；同 owner/stem 中只有唯一 JPG + 唯一 ARW/DNG 才进入 pair。

### 2.2 Immich v3.1.0 wire 合同

已核实的固定写面：

- endpoint：`POST /api/stacks`；正常成功状态码为 `201`。
- body 只有 `{ "assetIds": ["<JPG UUID>", "<RAW UUID>"] }`，JPG 必须第一项，因此成为 primary。
- 不发送 `name`、`If-Match`、expected Stack、client Stack ID 或虚构的 `Idempotency-Key`。
- v3.1.0 没有可用于本工具的原子“两个 Asset 仍无 Stack”CAS 前置条件，也没有服务端幂等 key。
- 写响应使用独立严格 validator：必须有 canonical `id`、canonical `primaryAssetId`、`assets[]`，成员集合必须恰好等于两个目标，且 JPG 为 primary。

已核实的 Immich 源码/规格事实保留如下：create repository 可能吸收输入中作为 primary 的既有 Stack 并重写成员关系；即使 body 只有两个 ID，也不能把影响范围承诺为最多两个 Asset。普通 Stack 保护因此依赖临写前读、单 writer、并发 1 和写后独立复核，但这些措施不等于服务端原子隔离。

证据：

- <https://github.com/immich-app/immich/blob/v3.1.0/open-api/immich-openapi-specs.json>
- <https://github.com/immich-app/immich/blob/v3.1.0/server/src/controllers/stack.controller.ts>
- <https://github.com/immich-app/immich/blob/v3.1.0/server/src/dtos/stack.dto.ts>
- <https://github.com/immich-app/immich/blob/v3.1.0/server/src/services/stack.service.ts>
- <https://github.com/immich-app/immich/blob/v3.1.0/server/src/repositories/stack.repository.ts>

## 3. Plan builder

`src/stack-write-plan.ts` 的 `buildStackBatchPlan` 在生成 plan 时：

1. 要求 source run 是配置 report root 的直接子目录，并拒绝不安全路径、重解析边界和非普通文件。
2. 验证 B1 是 `B1_READONLY`、Immich `3.1.0`、不可执行 manifest，并验证 frozen groups、全部 outcome 和成功 detail projection 的一一覆盖关系。
3. 以 frozen group 为完整性边界逐组筛选：某一成员失败、缺失或虽成功但 `originalTime` 未验证，会排除整组并记录 `DETAIL_GROUP_TIME_UNPROVEN`（适用时），不能删除坏成员后把原歧义组缩成唯一；其他完整组继续重新运行纯 pairing，不信任保存的 candidate 标签。
4. 重新检查 owner、当前 explicit library UUID、verified localSecond、`isTrashed=false`、`isOffline=false` 和 source `stack=NONE`。
5. 为每对生成稳定 `pairId=SHA256(domain, deploymentId, ownerId, jpgAssetId, rawAssetId)`，保留原 B1 `proposalId`，保存 expected-before snapshot 和固定 request digest。
6. 把 ambiguous/rejected/unverified group 计入排除摘要，不进入可调度 pairs。

plan digest 覆盖全部语义字段。`write` 使用 exclusive create；`load` 重新计算 digest，任何篡改都在 SQLite 或 transport 之前停止。

## 4. SQLite 注册表与状态

默认路径为 `I:\ai\immich-pair\data\pairs.sqlite`。`PairRegistry.initialize` 只在 apply 需要时创建；`status` 对不存在的数据库只报告错误，不创建替代库。SQLite 使用 `foreign_keys=ON`、`synchronous=FULL` 和 DELETE journal；没有新增 npm 依赖，运行时使用 Node 24 `node:sqlite`。

表的职责：

- `registry_meta`：schema、registry id、deployment id。
- `write_plans`：按 plan digest 保存完整 plan。
- `pairs`、`asset_claims`：pair ownership、双侧 claim 和注册状态；同 Asset 不能被第二 pair claim。
- `authorizations`：每次新的显式确认创建新的审计记录，只保存 confirmation digest、有效期、最大/已消费 dispatch attempts，不保存明文 token；旧授权过期不阻止后续新确认。
- `operations`：每对唯一 operation，保存 state、revision、attempt count、response Stack id、receipt、post observation 和错误摘要。
- `receipts`：严格校验后的白名单 receipt 投影。
- `batch_checkpoints`：按 plan digest 保存 next index/total pairs/更新时间；它是进度提示，不取代 operation state。coordinator 的完成判定只读取当前 plan 的 operation/pair/checkpoint，不受同库其他 plan 的 PREPARED/UNCERTAIN 污染。
- `journal_events`：只追加 `PREPARE`、`DISPATCH_INTENT`、`ACKNOWLEDGED`、`UNCERTAIN`、`UNATTRIBUTED`、`BLOCKED`、`COMMITTED`、`CHECKPOINT` 等事件。

operation 状态：

```text
PREPARED ──> DISPATCH_INTENT ──> ACKNOWLEDGED ──> COMMITTED
   │                 │                    │
   └─> BLOCKED       └────> UNCERTAIN ───┘
                                  │
                                  └─> UNATTRIBUTED pair（无 receipt 的等价 Stack）
```

所有关键更新使用 `WHERE operation_id=? AND state=? AND revision=?` 的 expected-revision 条件；CAS 失败时不调用 transport。claim 在 uncertain/unattributed 状态仍保留，避免第二次 plan 绕过本地 ownership。

## 5. Apply/resume 语义

`src/stack-registration.ts` 的 coordinator 固定串行执行：

- `PREPARED`：对 JPG/RAW fresh `getAsset`，验证 id、owner、文件名、library、verified localSecond、checksum/metadata snapshot、trash/offline 和 `stack=NONE`；任一不符则 BLOCKED，零 POST。
- 前置读成功后，在网络调用前以 SQLite transaction 消费一次 authorization attempt 并提交 `DISPATCH_INTENT`。intent 已提交就视为可能已发送。
- runtime-only `StackWriteCapability` 只携带 operation、authorization 和有序 `[jpg, raw]`，不能从 JSON 反序列化。
- transport 最多调用一次 `createPairStack(capability)`。网络错误、超时、断流、未知响应或 schema 错误均不重试，operation 进入 `UNCERTAIN`。
- 合法 receipt 先保存 `ACKNOWLEDGED`，然后重新独立读取两侧 Asset 与 Stack；Stack id、成员集合、assetCount、JPG primary 和两侧绑定全部匹配才 `COMMITTED`/`REGISTERED`。
- 已有 `DISPATCH_INTENT`、`ACKNOWLEDGED` 或 `UNCERTAIN` 的 operation，`apply` 和 `resume` 都只走 read-only reconcile，不再创建 capability、不再 POST。
- 有合法 receipt 且独立观察精确匹配才 commit；ACKNOWLEDGED 后 post-read 失败进入 `UNCERTAIN` 时仍保留 receipt/responseStackId，后续精确匹配可直接 `UNCERTAIN -> COMMITTED`，不再 POST。没有 receipt 但看到等价 Stack，只标记 `UNATTRIBUTED`，不能把它认领为本工具创建。
- 观察 NONE 不能证明未知 POST 没有迟到生效，继续保持 `UNCERTAIN`；不同 Stack、第三成员、primary 改变或 metadata drift 标记 BLOCKED/DRIFTED。

checkpoint 发生在每对 outcome 持久化之后。resume 从 operation 状态扫描，而非盲信 next index，因此可以覆盖“operation 已写入但 checkpoint 尚未写入”的进程中断窗口。

## 6. CLI 门

```powershell
# 只读预览，不落计划文件，不访问网络
npm run cli -- phase-b batch preview `
  --config 'I:\ai\immich-pair\phase-b-live-detail-20260911.config.json' `
  --source-run 'I:\ai\immich-pair\reports\phase-b-live-detail-20260911\<B1_RUN>'

# 生成独立计划；不修改 B1 run
npm run cli -- phase-b batch plan --config '<B1_CONFIG_JSON>' --source-run '<B1_RUN_DIR>' --output '<NEW_PLAN_JSON>'

# 离线 mock batch apply；必须显式写 transport、确认 token 和 plan
npm run cli -- phase-b batch apply --plan '<PLAN_JSON>' --db 'I:\ai\immich-pair\data\pairs.sqlite' `
  --transport mock --confirm LOCAL_MOCK_BATCH_APPLY

# resume：已有 intent/unknown 只读 reconcile；PREPARED 新 dispatch 仍需确认 token
npm run cli -- phase-b batch resume --plan '<PLAN_JSON>' --db 'I:\ai\immich-pair\data\pairs.sqlite' `
  --transport mock [--confirm LOCAL_MOCK_BATCH_APPLY]

# 只读 SQLite status，不创建数据库、不访问网络
npm run cli -- phase-b batch status --db 'I:\ai\immich-pair\data\pairs.sqlite'

# 单 pair live-smoke 静态准备：不读 key、不创建 registry、不访问网络
npm run cli -- phase-b live-smoke prepare --plan '<PLAN_JSON>' --plan-digest '<FULL_PLAN_SHA256>' --pair-id '<PAIR_ID>'

# 未来才可人工执行；必须逐项回填 prepare 输出，key 只从 non-TTY stdin 一行读取
$apiKey | npm run cli -- phase-b live-smoke run --plan '<PLAN_JSON>' --plan-digest '<FULL_PLAN_SHA256>' `
  --pair-id '<PAIR_ID>' --operation-id '<OPERATION_ID>' --confirm '<BOUND_CONFIRMATION>' `
  --transport live --db 'I:\ai\immich-pair\data\pairs.sqlite'

# 从 READY MOCK evidence plan 派生独立 full live-batch plan；不打开 DB、不读 key、不 fetch
npm run cli -- phase-b live-batch prepare --source-plan '<MOCK_PLAN_JSON>' `
  --source-plan-digest '<FULL_SOURCE_DIGEST>' --max-new-posts 20 `
  --output '<NEW_LIVE_BATCH_PLAN_JSON>'

# 未来人工执行；resume 使用相同完整绑定，operation state 决定只读恢复或新 dispatch
$apiKey | npm run cli -- phase-b live-batch run --plan '<LIVE_BATCH_PLAN_JSON>' `
  --plan-digest '<FULL_LIVE_DIGEST>' --candidate-count '<EXACT_COUNT>' `
  --deployment-id '<DEPLOYMENT_ID>' --max-new-posts 20 --confirm '<BOUND_CONFIRMATION>' `
  --transport live --progress terminal --db 'I:\ai\immich-pair\data\pairs.sqlite'
```

`maxNewPosts` 是 invocation 级静态绑定，必须为正安全整数且不超过完整 candidate count；confirmation 同时覆盖 full live digest、完整 candidate count、deployment ID 和该 limit。20 只是首轮 canary 的人工选择，正式 invocation 可显式绑定完整 candidate count。达到 limit 是正常切片完成，返回 `PAUSED`/`sliceCompleted=true`，不会把剩余 PREPARED 当成失败。下一次 resume 必须再次显式提供 limit 和对应 confirmation；COMMITTED pair 按冻结顺序跳过且不占新 POST 配额。`--progress terminal` 是 run/resume 的可选精确值，只向 stderr 输出无凭据、confirmation、receipt 或路径的 durable 进度；省略时 stdout 仍只有最终 JSON。

`phase-b preview|plan|apply|resume|status` 也作为 `phase-b batch ...` 的短别名提供。plan/apply/resume 的 CLI transport 仍只允许 `mock`。`live-smoke run` 必须显式且精确提供 `--transport live`，缺失、`mock` 和大小写变体均在 DB/stdin/transport/fetch 前拒绝；它不接受 batch action、默认 pair、多 pair、`--max-operations` 或 argv credential。live transport 只允许 `GET /api/assets/{id}`、`GET /api/stacks/{id}` 和一次 capability-gated `POST /api/stacks`，POST 零 retry、拒绝 redirect、只接受 201 和严格二元 receipt；POST unknown 先持久化 `UNCERTAIN`，随后同次调用执行一次只读 reconcile，且 posts 始终为 1。

CLI mock server 使用 SQLite 同目录下按 plan digest 命名的独立 JSON 状态文件。文件绑定 mock instance、registry/deployment 和 plan digest，包含远端 Asset/Stack 投影及单调 `nextStackNumber`；每次 mock 服务端变更先写临时文件、`fsync`，再原子 rename。它不读取 registry receipt，也不由 ACK/UNCERTAIN 反推远端状态；新进程必须从该远端状态文件重新观察。

## 7. 模块清单

| 文件 | 职责 |
| --- | --- |
| `src/stack-write-contracts.ts` | plan、pair snapshot、receipt、operation/status 合同和默认门 |
| `src/stack-write-plan.ts` | B1 输入完整性重验、重配对、plan digest、exclusive plan 文件 |
| `src/stack-live-batch-plan.ts` | MOCK source 完整性 gate、独立 live schema/digest、exclusive live plan 文件 |
| `src/stack-write-policy.ts` | confirmation digest、mock gate、runtime capability、request/receipt 条件 |
| `src/stack-write-client.ts` | 窄 `createPairStack` transport、严格 receipt validator、无 socket 且可跨进程恢复的独立 mock server state |
| `src/pair-registry.ts` | Node `node:sqlite` 向前 schema migration、多 plan membership、canonical operation/claims/receipt、deployment lease、journal |
| `src/stack-registration.ts` | mock/smoke 流程及 live-batch 并发 4 fail-stop dispatcher、receipt Stack-only 正常 post-read、resume/reconcile |
| `tests/phase-b-write-critical.test.ts` | 3 条目标导向 smoke/critical 流程 |

既有 B1 `PhaseBReadPolicy`/`PhaseBReadClient` 保持不变；B1 的只读 POST `/api/search/metadata` 与 Stack batch 的 POST `/api/stacks` 是两个独立 transport 面。

## 8. 验收结果与限制

已验证：

- Node `v24.12.0` 与 `node:sqlite` 可用，不新增 npm 依赖。
- fresh evidence MOCK plan：1,358 unique pairs / 2,716 assets、443 ambiguous groups，`DSC03720` current-stack 排除；source digest `198c820685106046ba480c1155858550ffcd84837321ca74aa30f5068d273986`。
- live-batch 合成验证覆盖并发上限 4、intent-before-POST、strict receipt + 单次 Stack GET、旧 canonical COMMITTED/receipt/attempt 保留、重开零重复、unknown fail-stop/read-only resume 和 pre-read drift 零 POST。

## 8. All-libraries V2

`phase-b all-libraries inspect` 是可复用的只读 evidence 入口：显式 `--library-scope all|uuid|null`，严格区分 UUID、NULL 与 ABSENT；全账户 search 分页后只在同一 `LibraryBinding` 内 group，并 fresh GET 相关 Asset detail。它动态生成独立 `B2_B3_STACK_BATCH_PLAN_V2` 与 scope digest，已有 Stack 一律作为 `CURRENT_STACK_UNMANAGED` exclusion，不进入 pair/registry。

`all-libraries prepare` 只接受完整 V2 source digest并派生 `B2_B3_STACK_LIVE_BATCH_PLAN_V2`。V2 run/resume 不接受 max-new-posts，必须显式绑定 `concurrency=1..64`；confirmation 覆盖 live digest、完整 candidate count、deployment、library-scope digest 和 concurrency。resume reconcile 与新 dispatch 使用同一并发，网络读取可并发，SQLite durable mutation 仍通过同步 registry 单写串行执行。first anomaly 停止领取，最多 `concurrency-1` 个在途自然结束；one POST、zero retry、non-PREPARED no-repost invariant 不变。V1 loader、digest 和原 live-batch 参数保持兼容。
- `npm run typecheck`、`npm run test:critical`、`npm test` 全部通过；具体数字见 README/最终交接。

真实执行记录（2026-09-13）：用户确认具体 pair 与风险后，隔离的 `live-smoke` 对 `DSC03720.JPG + DSC03720.ARW` 发送一次 `POST /api/stacks`，创建 Stack `9907e03a-119b-4b8a-a2ec-0bd9c02932fd`；因 Immich 入栈会更新两项资产的 `updatedAt`，首轮旧判定进入 `UNCERTAIN`。修复为“pre-write 严格比较 `updatedAt`、post-write/reconcile 仅允许该字段变化”后，复用同一 operation 以零 POST 只读 reconcile 收敛为 `COMMITTED/REGISTERED`，累计 `attempt_count=1`。运行时凭据只在进程内存中使用；未访问原图，未执行 Asset/Stack 删除或回滚，未修改 Compose/Postgres。该记录不授权 batch live；未来每个真实 smoke 仍需用户确认具体绑定、风险和执行窗口。
