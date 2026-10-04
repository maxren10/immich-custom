# Phase B0/B1 离线交接记录

版本：2026-09-12
状态：B0/B1 OFFLINE_IMPLEMENTED + scoped LIVE_READ_VERIFIED；B2/B3 `LOCAL_SINGLE_USER_SINGLE_WRITER` 完整 batch 已完成离线 mock 验证；真实 live detail/Stack POST 仍未执行。

本文件前半部分记录 2026-09-11 的 B0/B1 只读节点；B2/B3 当前实现、CLI、SQLite 状态机和风险口径以 [phase-b2-b3-stack-write-design.md](phase-b2-b3-stack-write-design.md) 与 [phase-b-stack-write-risks.md](phase-b-stack-write-risks.md) 为准。旧的“未做 SQLite/只能 canary”描述是当时节点事实，不是当前 batch 实现限制。

## 1. 本轮范围

本轮按已批准的 D1=A、D2=隐藏运行时 prompt contract、D3=单一明确 owner + 单一明确 library 的未来 live 范围、D5=不创建 SQLite、D7=普通 Stack 冲突 skip/report、D8=首次 Stack 写入另行授权、D9=原文件 evidence 延后实施：

- 冻结 Immich v3.1.0 wire contract，source commit 为 `8aa95c67470a02a8ddedf03c2e52963af33065ff`。
- 新增独立 adapter，校验 `users/me`、libraries、`assets.items/assets.nextPage`、Asset detail 和 Stack `assets[]`；metadata POST 明确发送 `Content-Type: application/json`，无 body 的 GET 不发送该 header。
- 新增 secret-safe credential provider contract；当前实现只接受隐藏运行时 prompt，secret 保存在 JS `#private` field，字符串、JSON 和 `node:util.inspect` 均只显示 redacted；不读取 `.env`/环境变量，不接受命令行明文 key，不把 key 写入 report/log。
- 新增 B 专用只读 policy/client：鉴权 header 是 `x-api-key`；公开接口不返回 raw `Response`，所有允许 read 都经过增量 bounded stream；每次 attempt 的 timeout 覆盖 fetch 与正文读取（不是跨 retry/backoff 的总 deadline）。明确瞬时 fetch/正文流 NETWORK failure、429 和部分 5xx 可有限重试，失败/重试响应体会被取消；401/403/400/404/redirect/schema 不重试。
- 新增 B1 inventory：不向 MetadataSearchDto 发送 ownerId；显式 library 分页，验证 `nextPage` 为正整数并跟随服务端返回的单调前进页码，排除 partner owner，两遍比较但始终 `snapshotGuaranteed=false`；列表 DTO 缺失 ownerId 时必须 detail 复核，detail `id` 必须等于 requested id 后才核 owner，验证过的 selected-library evidence 保留在 compatibility 输出中；仍缺失则 `LIBRARY_PROOF_UNAVAILABLE`/`INCOMPLETE`。
- 配对 RAW 一侧现支持 ARW 与 DNG；兼容字段 `arwAssetId`/`arwSourceId` 继续表示 RAW 槽位，避免破坏已有报告和恢复协议。
- 新增 Stack observer：搜索缺失 stack 为 UNKNOWN；detail 的 null 才是 NONE；保留 Asset detail `stack.assetCount`，Stack 可见成员从 response `assets[]` 投影；已知第三成员或 detail/可见成员不一致不能分类为等价；普通 Stack 只观察/分类，不接管。
- inventory 首遍和 compatibility 的同一认证流程遇到 401 后立即停止后续请求，输出结构化 `AUTHENTICATION` issue；非认证错误仍按既有 bounded 行为处理。
- 新增 Map/reducer registration protocol：`pairId` 纳入显式 `deploymentId`，幂等 key 不重复建 operation 且语义不一致时 fail closed，同 Asset claim 冲突阻塞，`DISPATCH_INTENT` 后不自动重发；已有可靠 response Stack ID 的 `ACKNOWLEDGED → UNCERTAIN` 可在匹配远端观察后提交，否则保持 `UNCERTAIN`/`UNATTRIBUTED`。
- 新增 B report writer：reportDir 规范化后与明确照片根做简单双向 containment 检查；独占 run 目录，写 compatibility/assets/stack-observations/registration-plan/issues，writer 对稳定排序后的明确语义负载直接计算 SHA-256 `planDigest`，manifest 最后写入，所有 B0/B1 manifest 固定 `executable=false`、`canBeUsedForStackWrite=false`。
- CLI 保留 offline `protocol-check`/范围配置提示和 B0/B1 阶段拒绝，并新增显式 `phase-b live-detail` 入口；该入口只在非 TTY stdin 提供一行运行时 key 后执行只读 compatibility、inventory 和 detail GET，不接受命令行/环境变量秘密，也不接入任何写 worker。live-detail 参数语法严格限制为一个 `--config VALUE` 和可选一个 `--resume-run-dir VALUE`；live、顶层和 phase-b unknown/credential-like token 都在读取 config、stdin 或网络前以固定文本拒绝，不回显用户 token。本轮未运行真实入口，只运行了 CLI help。

## 2. 关键不变量

- 本轮没有 SQLite（包括 `:memory:`），没有 Immich PostgreSQL/Compose 修改，没有真实照片、`I:\photos\unmodified` 或 `/mnt/photos` 访问，没有 original/download endpoint，没有 Stack/Asset/Trash/Library/Job 写请求。
- A 阶段模块、报告语义和已有测试保留；B client/policy 不改写 A 的旧接口，避免把 A 的历史 Bearer/ownerId mock contract 静默改成 B wire。
- B metadata report 只保留安全 projection；不输出 credential、authorization header、原始 response/error 或二进制。
- `libraryId` 在 adapter 内明确区分 absent/null/UUID；被显式 library 过滤的 owner Asset 若 libraryId 不能证明为目标 UUID，则 inventory fail closed。
- 任何普通 Stack 冲突都不产生 Stack write capability；B0/B1 没有 capability 构造路径。

## 3. 修改文件

新增：

- `src/phase-b-contracts.ts`
- `src/immich-v310-adapter.ts`
- `src/credential-provider.ts`
- `src/phase-b-config.ts`
- `src/phase-b-read-policy.ts`
- `src/phase-b-read-client.ts`
- `src/phase-b-inventory.ts`
- `src/phase-b-pairing.ts`
- `src/stack-observer.ts`
- `src/registration-protocol.ts`
- `src/phase-b-report-writer.ts`
- `src/phase-b-detail-plan.ts`
- `src/phase-b-detail-checkpoint.ts`
- `src/phase-b-detail-runner.ts`
- `tests/phase-b-wire-critical.test.ts`
- `tests/phase-b-stack-protocol-critical.test.ts`
- `tests/phase-b-boundary-critical.test.ts`
- `docs/phase-b-handoff.md`

整合：

- `src/cli.ts`
- `package.json`
- `README.md`

本目录无 Git 元数据；以上清单是本轮文件范围核对基线。`dist/` 仅为 typecheck/test 生成的构建产物。

## 4. Astra findings 成本收益重评（2026-09-11）

用户将本地单用户纯自用工程标准明确为 `Practical > theoretical`、`Working > perfect`、`Simple > defensive`。因此 Astra 原 `1 High + 6 Medium` 不再作为必须全部清零的发布门禁，按正常功能、数据判断价值和维护成本重新取舍：

- 已修：metadata JSON POST 的 `Content-Type`；library detail requested-id/owner 顺序校验与 selected evidence；Asset detail `stack.assetCount` 保留及第三成员保守分类；401 停止同一认证流程并输出 `AUTHENTICATION`；reportDir 对明确照片根的简单 containment；writer 内部稳定语义 `planDigest`，且 caller 不能覆盖。
- 本节点新增：Asset detail `exifInfo.dateTimeOriginal` 的 `NOT_READ/VERIFIED/MISSING/INVALID/CONFLICT` evidence union；`SEARCH` 永远 `NOT_READ`；带显式 offset 的时间结合可识别 `UTC±H`/`UTC±HH:MM` 重建 localSecond；JPG/JPEG 与 ARW/DNG 的纯函数候选配对、稳定排序与 SHA-256 digest。`localDateTime` 只做一致性校验，不能 fallback。
- 本节点新增 `B1_DETAIL_ENRICHMENT_PLAN` 离线预筛：要求 COMPLETE + TWO_PASS_STABLE 和全量 SEARCH/NOT_READ；跨 library 按 owner + NFC lowercase stem 合并，同 stem 的全部跨角色资产（包括重复同侧）保留为 detail proposal，单侧/其他扩展名排除。旧报告 7,083 行的影响基线为 JPG 3,746、RAW 3,337、两侧 stem group 1,803、唯一一对 1,360、重复同侧 443，预计 4,488 个 detail GET；这是本地规划数字，不是已执行 live detail。
- 明确 defer：configPath 在任意 fs 调用前对照片根“零触达”；checkpoint 已增加普通 file/dir 与每次写前 existing-ancestor/reparse 重检，但检查和 I/O 之间的句柄级 TOCTOU 仍为 residual risk，不做句柄级大重构；fs adapter/call-count architecture；`nextPage` 必须严格等于 `page + 1`（冻结 contract 只要求正整数并跟随前进页码）；所有外部 `*Digest` 的通用 64hex 防御框架；围绕这些理论边界的重复测试。
- 本次收敛已撤回短暂加入但未交付的 config/report fs adapter、零触达调用计数测试、严格连续分页限制和通用 canonical digest/64hex 框架。defer 项不是当前 blocker，后续只有出现实际可复现故障或用户改变标准时再启动。
- 增量 blocker 已纳入：detail 使用 `PhaseBDetailReadClient` 强制 `maxRetries=0`，cap 按实际 dispatch attempt 计；checkpoint 升级为不兼容 v2，v1 零 dispatch 拒绝；每次可能的 batch dispatch（包括已有未完成 reservation 的恢复重发）前写新的不可回退 reservation，所有历史 reservation 保守累计入 cap，公开 `reserveBatch` 和读取入口都拒绝 aggregate over-cap，预算不足不部分调度；runner 只接 `getAsset`，401 停止新调度；`PhaseBDetailRequest.libraryId` 纳入 plan digest/frozen binding；同 stem 先由 frozen plan + outcomes 做全量完整性 gate，再调用纯 pairing。没有引入 SQLite、逐项状态机或 `getStack` 入口。
- 本轮 P1/P2 收敛：cap 固定不超过 4,488、batch 不超过 100、并发不超过 2；fresh over-cap/越界参数在创建 run/checkpoint、reservation 和任何 GET 前停止。checkpoint v2 对 run/child 类型、existing-ancestor/reparse、completed batch、reservation aggregate 做 fail-closed 校验；非法 v1/frozen-over-cap/aggregate-over-cap 不新增文件、不生成 manifest。`committedDispatchedAttempts` 与 `reservedBudget`/`reservedAttemptUpperBound` 分开审计，`dispatchedAttempts` 只作为与 committed 相等的兼容别名，401 本次未提交尝试单列 `observedUncommittedAttemptsThisInvocation`；成功但非 VERIFIED 的 detail 仍进入安全结果报告而不进入候选。resume 只能位于同一 reportDir 的直接子目录且 basename 匹配 frozen runId。保留 `contentDigest` 真文件 SHA-256 实现与回归，未引入逐 request 磁盘文件。

## 5. 测试证据（2026-09-11，当前工作区）

```powershell
npm run typecheck
npm run test:critical
npm test
```

`test:critical` 必须包含原有 A critical 测试和本轮三个 B 测试文件；`npm test` 必须包含完整 `dist/tests/*.test.js`。B 测试只使用 fake fetch、合成 UUID、临时测试目录和内存 Map，不连接 Immich、不读取照片。

实际结果：

- `npm run typecheck`：退出码 0。
- `npm run test:critical`：退出码 0，32 tests pass，0 fail；包含原有 critical 和三个既有 B 测试文件。
- `npm test`：退出码 0，34 tests pass，0 fail；原有稳定测试继续通过。
- `node -e`/`node:util.inspect` 凭据复现：`console.log`、`String`、`JSON.stringify` 和 `inspect({showHidden:true})` 均只输出 `[REDACTED]`，不含 sentinel；`PhaseBReadClient.prototype` 不再暴露 raw `request`。
- `npm run cli -- phase-b protocol-check`：退出码 0，输出 `OFFLINE_IMPLEMENTED`、`network=not attempted`、`executable=false`、`canBeUsedForStackWrite=false`。
- `npm run cli -- phase-b protocol-check --report-dir I:\\ai\\immich-pair\\reports\\phase-b-verification-20260911-practical`：成功创建新的独占 synthetic B1 run；`network=not attempted`，manifest 为 `COMPLETED_WITH_ISSUES`，gate 为 `LIVE_READ_NOT_RUN` 和阶段写门禁，两个能力标志均为 false。新产物位于 `reports\\phase-b-verification-20260911-practical\\run-b-mtvqtlw0-a9c00e23e3382eb6`；此前三个 20260910 报告目录均保留、未修改或删除。
- 新报告的 5 个 detail files 已逐一复算 bytes/SHA-256，均与 manifest 相符且写入时间不晚于 manifest；按 writer 的直接语义负载复算 `planDigest=25953bf1635d0b6095bb1a1fe48f9f02e75edf944404e238ef68a1d4a00b635a`，与 manifest 一致。
- forbidden-surface 静态检查：B 新生产模块没有 SQLite driver/import、Postgres/Docker/Compose、original/download 或 Immich 写 endpoint；唯一的 `POST` 是受 policy allowlist 约束的 metadata search。`Bearer`/`Authorization`/`.env` 仅出现在脱敏、拒绝和阶段边界文字中，没有对应的发送、加载或写入路径；阶段拒绝保留明确的 `SQLITE_FACTORY`/`STACK_WRITE_TRANSPORT` deny token。

## 6. 真实只读验证与未完成范围

- 真实 owner `74ba8f23-a328-4604-b279-6f84e558cfd8`、library `0b30699e-b167-40d4-8f22-042d0e11b4c8` 已由用户明确选择并通过 v3.1.0 wire adapter 验证；library 名为 `New External Library`。
- 真实 B1 inventory 两遍各读取 71 页，均得到 7,083 个 Asset，结果为 `COMPLETE/TWO_PASS_STABLE`、0 issue；仍固定 `snapshotGuaranteed=false`。报告位于 `reports\phase-b-live-read-20260911\run-b-mtvsid7d-bec8ab06205ec2e4`，5 个 detail files 的 bytes/SHA-256、7,083 行资产计数、manifest 最后写入和语义 `planDigest` 均已独立复算匹配，凭据标记扫描无命中。
- 用户确认当前 library 没有既有 Stack；该陈述不冒充逐资产 API 证明。既有最小 Asset detail 探测选择 `DSC03720.JPG` 与 `DSC03720.ARW`，两侧均返回 `stack=null`，并返回相同的 `exifInfo.dateTimeOriginal=2026-02-16T03:53:27+00:00`、`timeZone=UTC+9`、`localDateTime=2026-02-16T12:53:27.000Z`。本节点把这组三字段的已观察值固化为离线回归 fixture，复核得到 localSecond `2026-02-16T12:53:27`，未新增真实 API 调用。
- 本机测试凭据由用户在可见 PowerShell `SecureString` prompt 中输入，并以当前 Windows 用户 DPAPI 密文保存于仓库外 `C:\Users\15372\.immich-pair-secrets\api-key.dpapi`；ACL 仅当前用户和 SYSTEM。key 明文未进入命令参数、环境变量、报告或工具输出。正式 `credential-provider.ts` 的 prompt-only contract 未修改；DPAPI 仅是用户批准的本机测试启动来源。
- `.DNG` 已按用户决定与 `.ARW` 一样进入 RAW 逻辑槽位；兼容字段名继续使用 `ARW`/`arwAssetId`/`arwSourceId`。新增 JPG+DNG、缺 `dateTimeOriginal` 不 fallback、矛盾字段、重复 RAW 和输入顺序稳定 digest 的最小回归，critical 26/26、full 28/28 均通过。
- detail-plan 回归还覆盖 incomplete/unstable inventory、DETAIL/VERIFIED 混入时整体 BLOCKED 且 requests 为空，以及跨 library、JPG+DNG、重复同侧、孤立 stem 和其他扩展名的计数与稳定 digest。
- detail-runner 回归覆盖 `libraryId` 冻结绑定、零 retry、实际 dispatch 次数、403 继续、401 停止新调度与未提交字段、整 stem failure gate、reservation budget、未完成 reservation 恢复时新增 reservation 且不突破 cap、v1/aggregate-over-cap 零 dispatch零新增文件、真实 directory junction 与普通 child/entry 类型拒绝、完整 batch resume、`.tmp` orphan 忽略和 plan/library 变化时零 detail；另覆盖 over-cap/越界参数零 dispatch、合法 JSON 的 frozen binding 错误零 dispatch、外部 resume 路径及三层 CLI unknown/sensitive token 不回显。完整结果重新从已提交 batch 文件聚合，manifest 最后写入，所有能力标志保持 false。
- 2026-09-12 最终本地验证：`npm run typecheck` 通过，`npm run test:critical` 33/33，`npm test` 35/35；`npm run cli -- --help` 与 `npm run phase-b-live-detail -- --help` 均 exit 0。测试仅使用 fixture/mock/临时目录，没有执行真实 detail GET。
- 未创建 SQLite，未实现 registry init/inspect/迁移；B2 需另行授权路径和创建时点。

## 11. 2026-09-12 B2/B3 完整 batch 实施补充

- 新增 `src/stack-write-contracts.ts`、`src/stack-write-plan.ts`、`src/stack-write-policy.ts`、`src/stack-write-client.ts`、`src/pair-registry.ts` 和 `src/stack-registration.ts`。
- 新增 `phase-b batch preview|plan|apply|resume|status`，并提供无 `batch` 的短别名；apply/resume 仅允许显式 `--transport mock --confirm LOCAL_MOCK_BATCH_APPLY`，本节点不 wiring live client。
- B1 live-detail 产物只读 preview 复算为 1,359 个唯一 candidate、443 个 ambiguous group、0 个 current Stack blocker；B1 manifest/文件内容未修改。
- SQLite 默认 `I:\ai\immich-pair\data\pairs.sqlite`，Node 24 `node:sqlite`，concurrency=1；注册表持久化双侧 claims、attempt quota、dispatch intent、receipt/outcome、checkpoint 和 append-only journal。
- 新增三条目标导向 critical 流程：完整 batch 成功且二次 apply 零 POST；未知结果跨 reopen 只读 reconcile 且总 POST=1；fresh Stack conflict 零 POST。
- Review 修复：CLI mock server state 独立原子持久化并绑定 plan，跨进程保持远端 Stack/ID；有 receipt 的 `UNCERTAIN` 可在精确读回后无 POST commit；每次新确认创建新 authorization；B1 失败/不健康只按 frozen stem 整组排除且不阻塞其他合格组；coordinator 完成状态按当前 plan digest 统计。
- 验证：`npm run typecheck` 通过，`npm run test:critical` 36/36，`npm test` 38/38。Node 24 的 SQLite experimental warning 不影响结果。
- 未执行真实 POST、真实 live detail、API key、原图、删除/回滚、Docker/Postgres 或前端工作；真实写入仍需用户另行确认具体 plan digest、scope、运行时 key、确认 token 与 TOCTOU 风险。
- 本节点未读取原文件或原始照片 Exif，未建立 Asset → 本地路径 evidence；B2 仍需另行授权并明确 mapping。这里的 Immich Asset detail `exifInfo` 只读 evidence 不等同于原文件 Exif evidence。
- 未发送 Stack create/update/delete 或任何 Asset/Trash/Library/Job 写请求；B3 需对具体 pair 单独授权，并先解决 v3.1.0 create 的并发竞态。
- 未启动 Hardening/Release、性能、完整 fault matrix、前端、删除或发布验收。

因此本交接可以宣称：B0/B1 的离线实现、真实 v3.1.0 compatibility、单 owner/library 两遍 metadata inventory、最小 Asset detail schema probe 和阶段拒绝边界已完成；B2/B3 的本地 SQLite 注册表、双侧 claims、checkpoint、mock batch 状态机和三条目标 smoke 已完成。不能宣称真实 live Stack 写入、生产远端状态 reconciliation、原文件 evidence 或真实 live batch 已完成。
# All-libraries V2 增量交接（2026-09-13）

- 新增一条可重复的 `phase-b all-libraries inspect -> prepare -> run|resume` 路径，支持 owner 的所有 UUID library 与明确 `libraryId:null`，且禁止跨 binding 配对。
- V2 使用独立 source/live schema、digest 和 library-scope digest；V1 文件、receipt 与 registry schema不迁移、不重写。
- inspect 是只读阶段，动态生成 report/source plan；CURRENT_STACK_UNMANAGED 仅 exclusion。
- V2 写入无分片参数；concurrency 必填 `1..64` 并进入 confirmation。resume 并行只读 reconcile 后再继续全部 PREPARED。
- 当前实现仅以 synthetic gateway/fetch/临时 SQLite 验证；尚未针对真实 Immich、API key 或正式 registry 执行。
