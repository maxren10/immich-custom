# Phase B 节点级设计：Immich v3.1.0 兼容、只读证据与本地批量 Stack

版本：2026-09-12
状态：B0/B1 只读实现已落地；All-libraries V2 runner 已完成 443/443 组真实 Stack 验证。
配套文件：phase-b-decisions-needed.md、phase-b-acceptance.md。
前置基线：product-requirements.md、decisions.md、全部 Phase A 设计、验收和交接文档。

> 口径更新：本文早期段落和历史表格曾按多 writer/canary-only 设计。当前运行合同以 [task-runner-implementation-handoff.md](task-runner-implementation-handoff.md) 和 [phase-b2-b3-stack-write-design.md](phase-b2-b3-stack-write-design.md) 为准：`LOCAL_SINGLE_USER_SINGLE_WRITER`、完整 All-libraries V2 batch、任务并发 1–64；当前部署使用 32，实际 Stack POST 门控为 4。B1 manifest 仍只读，legacy batch apply 仍只启用 mock transport。本文保留已核实的 Immich v3.1.0 wire facts。

本文定义整个 Phase B 节点，不按内部模块重复安排节点级 Design。后续实现由主代理在用户授权范围内组织；主代理负责差异检查、测试汇总和最后交接。正常在节点基本完成、测试已运行且普通问题已解决后进行一次只读 Review。

## 1. 事实、证据等级与限制

### 1.1 部署事实与本轮证据来源

以下部署事实由主代理在本轮实时验证；Astra 设计审查没有自行调用本机服务，因此不能把它们写成 Astra 的 live observation：

- Immich v3.1.0。
- 四个服务均为 healthy。
- GET /api/server/ping 成功。
- GET /api/server/version 成功并返回版本信息：{major:3, minor:1, patch:0}。
- GET /api/open-api 返回 404。

四个服务 healthy、ping/version 成功和 open-api 404 是本轮主代理的实时部署证据；它们不等于已经验证全部 API schema、权限或写入行为。/api/open-api 的 404 使本设计固定使用官方 v3.1.0 源码和 OpenAPI 文件作为契约来源，不依赖本机生成文档。

以下事实来自任务交接或部署描述，Astra 在设计审查中未自行验证，必须保持单独的证据等级：

- 本机服务端口为 2283。
- 外部照片库挂载为 RW。

RW 仅说明部署能力，不构成本项目的文件读取、文件写入、删除或 API 写入授权。B0/B1 禁止读取真实照片二进制，包括通过 original/download API 间接读取。

### 1.2 本轮已验证的源码事实

已完整阅读当前：

- src/contracts.ts
- src/config.ts
- src/readonly-policy.ts
- src/immich-read-client.ts
- src/inventory.ts
- src/pairing.ts
- src/report-writer.ts

已通过官方 GitHub tag 引用确认 v3.1.0 指向 commit：

8aa95c67470a02a8ddedf03c2e52963af33065ff

本机版本号不证明运行容器与该 commit 的构建字节完全一致。未来 B0 应记录“部署声明版本”“官方契约版本”“认证只读响应校验结果”三种证据，禁止合并成已经验证全部行为的结论。

### 1.3 当前实现与官方契约的差异

| 当前代码 | v3.1.0 事实 | Phase B 处理 |
| --- | --- | --- |
| API key 放入 Bearer | API key security scheme 使用 x-api-key；Bearer 进入 session token 路径 | B 客户端通过独立凭据提供器注入 x-api-key |
| metadata 请求带 ownerId | MetadataSearchDto 没有该字段 | 请求不发送；响应按 owner 检查与分区 |
| 假设顶层 assets[]、nextPage | 实际是 assets.items[]、assets.nextPage | 建立官方 wire adapter |
| 请求 page 可直接使用字符串 token | 请求 page 是正整数，响应 nextPage 是字符串或 null | 严格验证十进制 token 后转安全整数 |
| 读取 stackId，缺失默认为 null | AssetResponse 使用可缺省的 stack 对象；搜索映射不启用 withStack | 缺失为 UNKNOWN，必须读取 asset detail |
| 单个必填 libraryId | 官方 AssetResponse 的 libraryId 可缺省或 null | 内部区分缺失、null、UUID；范围使用显式集合 |
| Stack 内部是 assetIds | 官方 StackResponse 是 assets 数组 | 校验后投影成员 ID，不直接强制类型转换 |
| A PairDecision 固定 LOCAL_SAMPLE | 真实 Asset ID 具有不同语义 | 新增 B 类型，禁止伪装 A sourceId |
| A report writer 固定 A manifest | A 报告不可执行 | 保持 A writer，新增 B writer |

依据：[官方 OpenAPI](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/open-api/immich-openapi-specs.json)、[认证实现](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/server/src/services/auth.service.ts)、[搜索 DTO](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/server/src/dtos/search.dto.ts)、[Asset DTO 与映射](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/server/src/dtos/asset-response.dto.ts)。

A 的本地 dry-run 验收不因此作废；第一轮 mock 网络测试不构成真实版本兼容证明。

## 2. 子阶段与权限边界

| 子阶段 | 目标 | 允许的副作用 | 明确不允许 |
| --- | --- | --- | --- |
| B0 | 官方契约适配、凭据入口、只读兼容探测 | 经授权生成本项目报告 | 照片二进制读取、SQLite、Immich 写入 |
| B1 | 只读 inventory、Stack 观察、纯注册协议模拟 | 经授权生成不可执行报告；内存 Map 模拟 | SQLite，包括 :memory:；照片扫描；写 worker |
| B2 | B1 detail 证据重验、独立 SQLite 注册表、claims 和 checkpoint | 本地 SQLite 与离线 plan/mock 状态 | 原图读取、真实 Stack 写入、删除、前端 |
| B3 | 完整 batch apply/resume/status、逐对 fresh read/一次 create/reconcile | 本节点仅离线 mock；真实 live 需新的明确授权 | 普通 Stack 接管、自动重试 create、更新/解散/删除 Asset |

B2 有两个独立能力开关：

- registryPersistenceAuthorized
- originalEvidenceReadAuthorized

前者不隐含后者。可以只实现注册表并使用合成 evidence 验证持久化；不得把合成数据注册成真实已配对关系。

B0/B1 默认实现边界不等于用户已选定所有配置。待决策项未落实时可以完成离线实现与合成验证，真实认证调用等待明确的 key 提供方式和 owner/library 范围。

B3 的本地协议可以先在 B1 用纯状态转换和 mock transport 验证，不能把它解释为已经授权真实写 worker。

## 3. 官方接口核对方法与适配合同

### 3.1 来源与版本冻结

禁止依赖本机 /api/open-api。使用以下冻结来源：

- [v3.1.0 tag 引用](https://api.github.com/repos/immich-app/immich/git/ref/tags/v3.1.0)
- [对应 commit](https://github.com/immich-app/immich/commit/8aa95c67470a02a8ddedf03c2e52963af33065ff)
- [官方生成 OpenAPI](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/open-api/immich-openapi-specs.json)

每个接口按以下链路核对：

1. OpenAPI：method、path、请求和响应 schema、成功状态码、权限扩展。
2. controller：真实路由、admin 限制、版本迁移和 deprecated 情况。
3. DTO：必填、可空、缺省和验证条件。
4. service：资源级权限、响应映射和业务异常。
5. repository：仅在分页、成员可见性、事务或合并行为存在疑问时阅读。
6. 授权后的真实只读请求：只验证实际触达的响应与权限，不探测写接口。

记录 sourceCommit、相应文件链接、verifiedBy=SOURCE|LIVE_READ|MOCK、时间和未验证项目。不能把 mock 或官方源码阅读标记为 LIVE_READ。

### 3.2 接口矩阵

以下路径以 /api 为前缀：

| 接口 | 主要 schema / 成功码 | 权限与约束 |
| --- | --- | --- |
| GET /users/me | UserAdminResponseDto，200；至少投影 id、isAdmin | user.read；身份必须等于显式选择的 owner |
| GET /libraries | LibraryResponseDto 数组，200 | library.read 且 admin |
| GET /libraries/{id} | LibraryResponseDto，200 | 同上；核实 owner 和显式 library |
| POST /search/metadata | MetadataSearchDto → SearchResponseDto，200 | asset.read；属于只读查询 POST |
| GET /assets/{id} | AssetResponseDto，200 | asset.read 加资源可访问检查 |
| GET /stacks/{id} | {id,primaryAssetId,assets}，200 | stack.read 加 Stack owner 检查 |
| POST /stacks | {assetIds:[...]}，至少两个 UUIDv4；201 | stack.create；service 另检查输入 Asset 的 owner 更新访问 |
| PUT /stacks/{id} | {primaryAssetId?} → StackResponseDto，200 | stack.update；已 deprecated |
| PATCH /stacks/{id} | 当前 controller 存在，调用同一 update service | 被排除于当前生成 OpenAPI；首轮不选用 |
| DELETE /stacks/{id} | 无业务响应体，204 | stack.delete；B0/B1/B2/B3 首次创建均不授权 |

B3 仅考虑 POST /stacks。update/delete 的 schema 在本节点研究清楚，但不得因此在默认 policy 中放行。

依据：[User controller](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/server/src/controllers/user.controller.ts)、[Library controller](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/server/src/controllers/library.controller.ts)、[Library DTO](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/server/src/dtos/library.dto.ts)、[Stack controller](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/server/src/controllers/stack.controller.ts)。

### 3.3 Metadata 搜索

首轮 wire body 仅允许：

~~~ts
interface MetadataQuery310 {
  libraryId?: string;
  page: number;
  size: number;
  withStacked: true;
  withExif: false;
  withDeleted: false;
}
~~~

- 应用页大小固定上限 100；不是声称官方上限也是 100。
- page 从 1 开始。
- nextPage 只接受 null 或无符号十进制正整数字符串，转换后要求安全整数并单调前进；分页器跟随服务端返回的下一页，不自行假设必须连续为 `page + 1`。
- 所有页完整遍历；发现循环、重复 ID、非法响应或请求中断时 INCOMPLETE。
- 不以 total/count 替代分页完成证明。
- withStacked 表示查询包括堆叠资产，不表示响应带完整 Stack 详情。
- service 搜索范围可能含 partner 用户；服务端没有此 DTO 的 ownerId 过滤参数。
- 对其他 owner 记录明确的排除计数，不纳入所选 owner 的配对集合。
- 发起 library 过滤查询却收到不一致 libraryId 时视为范围异常，不能静默接受。
- 缺失 libraryId 不得解释成 null；缺失所需身份字段为 schema 不兼容。

搜索 service 在 metadata 映射时未传入 withStack:true，因此不能依据搜索结果省略 stack 推断无 Stack。[官方搜索实现](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/server/src/services/search.service.ts)。

两遍 inventory 比较应包括 ID 集合和每个 Asset 的核心元数据。两遍相等只表示观察稳定，始终记录 snapshotGuaranteed=false，不得称为数据库一致性快照。

### 3.4 Asset 与 Stack 详情

B 内部至少区分：

~~~ts
type StackObservation =
  | { kind: "UNKNOWN"; reason: string }
  | { kind: "NONE"; observedAt: string }
  | {
      kind: "PRESENT";
      stackId: string;
      primaryAssetId: string;
      reportedAssetCount: number;
      visibleMemberIds: string[];
      membershipComplete: boolean;
      observedAt: string;
    };
~~~

对详情中所需字段进行运行时校验：

- id 必须与请求 ID 相等。
- ownerId 必须与所选 owner 相等。
- originalFileName、originalPath、checksum、updatedAt、isTrashed、isOffline、visibility 保留为安全证据。
- detail 的 stack:null 才可形成 NONE 观察；缺失或非法 shape 为 UNKNOWN。
- Stack 详情 assets 内成员 ID 必须唯一，primary 必须存在。
- 两个 Asset 的 Stack 观察必须一致；不一致或变化时阻塞。

Stack repository 返回成员时存在 deletedAt、默认 visibility 和 EXIF join 过滤，故“响应正好两个成员”不自动证明实际成员正好两个。必须比较两侧 detail 的 assetCount、可见成员集合和已记录注册证据；无法证明完整性时 membershipComplete=false，禁止接管和修改。[Stack repository](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/server/src/repositories/stack.repository.ts)。

### 3.4.1 B1_DETAIL_ENRICHMENT_PLAN

这是一个离线纯函数规划节点，不执行 Asset detail GET。输入必须是完整且两遍稳定的 `PhaseBInventory`，并且全部资产仍然是 `source=SEARCH`、`originalTime.status=NOT_READ`；否则整个 plan 为 `BLOCKED`，`requests=[]`，不允许混合使用已读取 detail、`updatedAt`、file time 或其他 fallback。

规划只按 `(ownerId, NFC(lowercase(removeFinalExtension(originalFileName))))` 预筛 JPG/JPEG 与 ARW/DNG。一个 stem 同时存在 JPG 和 RAW 时，该 stem 的全部相关资产都进入 detail request proposal；重复同侧也全部保留，因为 detail 时间取得后可能拆分为多个有效 pair。单侧 stem 和其他扩展名不请求 detail。library、directory、hash、updatedAt 不进入筛选 key。

plan 与每个 request 均固定 `executable=false`、`canBeUsedForStackWrite=false`，并标记 `requiresLiveReadAuthorization=true`。不生成默认 batch size、并发数或 executor；后续必须按精确 requestCount 另行授权。

既有 7,083 行资产报告的离线预统计影响基线为：JPG 3,746、RAW 3,337、两侧 stem group 1,803、唯一一 JPG+一 RAW group 1,360、重复同侧 group 443；若未来获准全量补证，预计为 4,488 个 Asset detail GET。该数字只是从既有报告本地计算的规划基线，不是本节点已执行的 live detail 请求；2720 仅是唯一一对 group 的两侧资产数，不能当作完整范围。

### 3.4.2 LIVE_DETAIL_READ_AUTHORIZED 执行合同

当前实现的 live detail 入口仍只允许只读 detail GET，且不代表本轮已经执行真实请求：

- `PhaseBDetailRequest` 保存 `assetId`、`ownerId`、原文件名、逻辑 stem、角色和 `libraryId`；`libraryId` 进入 plan digest、冻结的 `run.json` 和 resume 全量比较。library 只用于范围绑定和审计，不改变 stem 分组 key。
- detail 使用独立的 `getAsset`-only gateway/client；该 client 强制 `maxRetries=0`。compatibility/inventory 可以继续使用原有 bounded retry，但 detail cap 按实际 Asset-detail HTTP dispatch attempt 计，不能因客户端重试绕过 4,488 上限，也不能按唯一 Asset ID 计数。
- checkpoint 协议版本为 v2；reservation-per-dispatch 是相对 v1 的不兼容安全语义，新 run 只写 v2，任何 v1（尤其 unfinished v1）在恢复入口零 dispatch fail closed，不做隐式迁移。
- 每批最多 100 个 request、并发最多 2。每次可能的 batch dispatch（包括已有未完成 reservation 的恢复重发）前先独占写入新的、不可回退的 `reservations/reservation-NNNN.json`；预算按所有历史 reservation 累计，崩溃后无法确认是否 dispatch 的 reservation 额度保守视为已消耗，已完成批次的历史 reservation 也不退款。`reserveBatch` 自身验证 aggregate + current 不超过 frozen cap；读取时 aggregate 已超过 cap 直接拒绝，不写 halted/final/manifest。完整批次结果写为 `batches/batch-NNNN.json`，临时 `.tmp` 文件不是事实源。checkpoint 读取和提交时都必须验证 batch index 合法且唯一、文件名与 index 一致、`requestIds` 精确等于 frozen slice、results 一对一且 `dispatchAttempted=true`；成功结果重新验证 DETAIL/source/id/owner/name/library 绑定，失败结果只允许固定 reason allowlist 且不得携带 asset。resume 读取同一 run 的全部 reservation 与完整 batch，不能重置 cap；剩余额度不足覆盖整个未完成批次时返回 `STOPPED_BUDGET`，不部分调度、不自动创建新 run。
- 401 将共享认证停止标志设为真，停止新调度；至多等待已经在途的另一个请求收尾。`dispatchedAttempts` 兼容别名始终等于 `committedDispatchedAttempts`；本次调用观察到但未提交的尝试单列为 `observedUncommittedAttemptsThisInvocation`，不冒充跨恢复累计。403/404/schema/network/size/final-5xx 等固定分类继续完成当前批，不输出原始 response、header 或错误对象。
- 最终完整性是纯函数 `evaluatePhaseBDetailOutcomes(plan, outcomes)` 的入口事实：每个 frozen request 都必须有 outcome，且成功结果必须精确绑定 detail 的 source/id/ownerId/originalFileName/libraryId，并且 originalTime 为 `VERIFIED`。任一失败、未调度、绑定不符或时间非 VERIFIED，整个 owner+stem 都没有 `CANDIDATE`；只有完整 stem 才能交给 `pairPhaseBAssets`，重复侧再按 localSecond 拆分。
- fresh run 的 cap 必须不超过 4,488、batch 不超过 100、并发不超过 2；计划超过 cap 时在创建 run、checkpoint、reservation 或任何 GET 前停止。report/resume 路径使用 readonly-policy 的 Windows 绝对路径、ADS/UNC/device/traversal 和 existing-ancestor reparse/junction guard；resume 的 canonical 目录必须是输入 reportDir 的直接子目录，basename 必须等于 frozen runId。`run.json` 与枚举到的 reservation/batch JSON 必须是普通文件，`reservations`/`batches` 必须是普通目录且都不能是 symlink/reparse；每次 reservation、batch、halted、final、manifest 写入前重新检查父目录、目标和所有现有祖先。检查与实际 I/O 之间仍存在句柄级 TOCTOU，这是当前明确保留的 residual risk，不在本轮做句柄级重构。
- 输出是 `final-summary.json`、detail outcomes/assets、pairing 和最后写入的 manifest；审计字段明确区分 `committedDispatchedAttempts`（已提交 batch 的真实尝试）、`dispatchedAttempts`（与前者相等的兼容别名）、`observedUncommittedAttemptsThisInvocation` 与 `reservedBudget`/`reservedAttemptUpperBound`（所有历史 reservation 的保守上界，包含未完成 reservation）。401/正常预算停止只有安全 halted summary；非法 v1、frozen over-cap 或 reservation aggregate over-cap 零写入拒绝，均不产生 completed manifest。所有 detail 产物固定 `executable=false`、`canBeUsedForStackWrite=false`、`snapshotGuaranteed=false`，不使用 SQLite、逐项持久化状态机、Stack API 或自动写入。

### 3.5 权限与错误语义

- API key 由 x-api-key 注入，不能放 URL、Bearer 或查询参数。
- 401：缺少/无效认证；立即停止该认证流程。
- 403：API key permission 或 admin 限制；禁止自动换 key、扩大权限。
- 400：可能是 schema 错误，也可能是资源不存在或没有访问权限；不能将其当作“Stack 不存在”。
- 404：可能是路由、代理或版本问题；不能据此推断资源可创建。
- 5xx：只读调用可有限重试；写请求可能已提交，必须进入不确定结果处理。
- redirect：在 fetch 前使用禁止重定向模式；任何 3xx 均拒绝。
- 2xx 但响应缺失/无法解析：只读为不兼容；写入为不确定结果。

资源访问检查实际会以 BadRequestException 合并“未找到”和“无权限”。Stack service 在权限检查后仍可能因竞态进入内部未找到错误；不得假定所有缺失资源都返回 404。[访问检查](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/server/src/utils/access.ts)、[Stack service](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/server/src/services/stack.service.ts)。

只读探测成功只能证明对应读取能力，不能证明 stack.create 权限已通过。首次写入前的权限要求需按冻结 controller/service 分别记录，禁止为“测试权限”发送真实写请求。

## 4. 配置、身份与凭据

### 4.1 无秘密配置

B 配置与 A 配置区分版本：

~~~ts
interface PhaseBConfig {
  configVersion: 2;
  mode: "B0_COMPAT" | "B1_READONLY";
  origin: "http://127.0.0.1:2283";
  expectedVersion: "3.1.0";
  ownerId: string;
  libraryIds: string[];
  credentialSource: "PROMPT";
  reportDir: string;
}
~~~

- libraryIds 非空、去重、UUIDv4，并由用户选择。
- B0 无需 sampleRoot、tempDir、ExifTool 或 SQLite 路径。
- 缺少配置不能猜测 owner、library、样本根或数据库路径。
- 配置中出现 apiKey、password、token 等秘密值字段，读取后立即拒绝且不输出字段值。
- 拒绝 .env 作为配置文件；不加载 dotenv，不搜索父目录配置。
- 真实 URL 继续固定 127.0.0.1:2283；“localhost 2283”是部署描述，不启用任意 origin。

### 4.2 凭据入口

本节点只提供隐藏输入的交互提示入口。凭据在运行时获取；未选中的环境变量入口不属于当前实现合同，不能通过配置或 provider 工厂绕过。

禁止 --api-key <value>、秘密 JSON 文件、PowerShell 命令文字中的明文 key、环境变量批量打印、自动读取 .env 或全局配置。

凭据对象只存在网络适配层内存中，secret 使用不可反射的 JS `#private` field；`toString()`、`toJSON()` 和 `node:util.inspect.custom` 均只返回 redacted 表示。错误和调试输出不得序列化配置、Request、Response 或底层异常对象。JS 字符串不能保证安全擦除，不声称退出前已可靠清零。

### 4.3 owner 与 library

- 首轮一个 owner；多 owner 应分开运行。
- owner 必须与用于 Asset 搜索/写入的 users/me.id 相同。
- admin 身份不等于可以代其他 owner 创建 Stack。
- libraries 查询是 admin route；不能假设普通 owner key 可列出。
- 非 admin owner 如需要 library 身份证明，可由用户选择单独的 admin 只读发现 key；该 key 仅用于 library 元数据读取，不成为 Asset 操作身份。
- 不自动选择第一个 library，也不自动把所有返回 library 纳入范围。
- 不同 library 的 Asset 合并为同一 owner 的匹配输入，library 永不进入匹配 key。

若只读权限不足，B0 可以交付“不完整兼容报告”，不能用用户输入的 UUID 冒充已验证的 library 所属关系。

## 5. 原始 EXIF 证据链与匹配

### 5.1 B0/B1 的 Asset detail original-time evidence

B0/B1 不读取二进制、不调用 original/download。metadata search 仍然使用 `withExif=false`，所以搜索结果的 original-time evidence 永远是 `NOT_READ`。经过冻结 v3.1.0 adapter 验证的 `GET /api/assets/:id` Asset detail 可以把 `exifInfo.dateTimeOriginal` 作为正式配对时间证据；这不是原文件 ExifTool 证据，也不改变搜索请求的只读范围。

Asset detail 的 evidence union 至少区分：

~~~ts
type ImmichOriginalTimeEvidence =
  | { status: "NOT_READ"; source: "SEARCH"; reason: string }
  | { status: "MISSING"; source: "ASSET_DETAIL"; reason: string }
  | { status: "INVALID"; source: "ASSET_DETAIL"; reason: string }
  | { status: "CONFLICT"; source: "ASSET_DETAIL"; reason: string }
  | {
      status: "VERIFIED";
      source: "ASSET_DETAIL";
      dateTimeOriginal: string;
      timeZone: string;
      localSecond: string;
    };
~~~

`dateTimeOriginal` 必须是带显式 `Z` 或 numeric offset 的 ISO datetime；必须存在并能结合可验证的 `UTC±H`/`UTC±HH:MM` `timeZone` 重建本地墙钟秒。`localDateTime` 只能作为一致性校验，不能在缺少 `dateTimeOriginal` 时 fallback。时区不认识、日期无效或两个字段矛盾时 fail closed 为 `INVALID`/`CONFLICT`。例如 `2026-02-16T03:53:27+00:00` + `UTC+9` 重建为 `2026-02-16T12:53:27`；亚秒只保留在输入审计中，不进入 key。

禁止通过 GET original 绕过文件根禁止访问规则。

### 5.2 B2 未来证据链

取得独立原文件只读授权后，链路为：

1. 验证 owner/library 范围和完整分页 inventory。
2. 读取 Asset detail，绑定真实 Asset ID、owner、library、originalPath、originalFileName、checksum 和 updatedAt。
3. 用显式配置的 server-prefix → host-root 映射解析本地路径。
4. 先做字符串级路径边界检查，再做允许根内的文件系统检查。
5. 读取前记录路径/文件身份、size、mtime、内容摘要。
6. 使用 A 的 ExifTool 只读参数规范读取原文件 ExifIFD。
7. 读取后重新验证文件身份、size、mtime、内容摘要和 Asset detail。
8. 重新枚举允许范围并比较集合，证明观察期间没有遗漏新增/移除候选。
9. 生成新的 B evidence、pair decision 和 digest。

本轮不选择任何实际映射，不读取映射指向的照片。

checksum 只作为 Asset 与原文件关联证据。官方响应将 checksum 描述为 Base64 SHA1；实现必须验证编码和摘要长度，按已验证算法比较。算法未知、字段缺失或不匹配时证据链未验证，不能改用“文件名看起来一样”。本地 SHA-256 用于内容稳定性和审计，不与不同算法的 Immich checksum 直接比较。

实际文件到 Asset 的一对一关联存在歧义时，阻塞注册写入；不能选最新、最小 ID 或第一个结果。

### 5.3 匹配规则不变

唯一匹配 key：

~~~text
(ownerId, NFC(lowercase(removeFinalExtension(basename))), originalLocalSecond)
~~~

- B Asset detail 的 localSecond 仅来自已验证的 `exifInfo.dateTimeOriginal` 与 `timeZone`；A 原文件路径仍只使用原文件 ExifIFD DateTimeOriginal。
- 忽略亚秒；先按 Asset detail 的时区重建本地墙钟秒，不把 UTC instant 直接当作配对 key。
- `localDateTime` 只能校验上述结果，不能充当时间来源。
- 同 key 恰好 1 JPG/JPEG 与 1 RAW（ARW 或 DNG）为 CANDIDATE；现有 `arwAssetId` 等字段名继续表示兼容的 RAW 槽位。
- 重复同 role 为 AMBIGUOUS。
- 原时间缺失、无效、冲突或不可读取为 UNVERIFIED。
- directory、library、camera model、serial、hash 不进入 key。

安全 eligibility 与规则 status 分开：一个按已验证输入成立的 CANDIDATE，仍可能因范围不完整、未知同 stem 文件、Stack 冲突或授权不足而不能执行。不能通过加严 key 偷改配对规则。

### 5.4 范围完整性

在用户选定的 library 集合内跨 library 合并匹配，但要记录这是所选范围的结果。

如果无法排除同 owner 范围外的同 key Asset，或者同 owner/stem 存在无法读取原始时间的潜在第三资产：

- 保留已有规则判定。
- 记录 cardinalityCoverage=UNPROVEN。
- canBeUsedForStackWrite=false。

未经授权不得扩大扫描去解决完整性问题；应作为未来证据范围授权项交给用户。

### 5.5 A 报告

A 报告只能引用为历史证据，不能转换成执行 manifest：

- LOCAL_SAMPLE_OWNER 不是已验证真实 owner。
- A sourceId 不是 Immich Asset ID。
- 即使 A 文件摘要一致，也必须重新验证真实 source snapshot、ruleVersion、owner、Asset ID、范围、权限及 B digest。
- A 的 canBeUsedForPhaseB=false 永不修改。
- 新 B 报告使用新的 runId 与类型，不覆盖 A 历史。

## 6. 普通 Stack 保护矩阵

匹配关系和 Stack 可操作性为两个独立维度。

| 当前观察 | 注册表证据 | 处理 |
| --- | --- | --- |
| JPG/RAW 都明确无 Stack | 无冲突占用 | 可成为未来 CREATE_NEW 候选；其他门禁仍必须通过 |
| 双方在同一 Stack，正好两侧且 JPG primary | 无本项目成功创建证明 | EXTERNAL_EQUIVALENT，只观察、不接管、不写 |
| 双方在同一 Stack，正好两侧但 ARW primary | 无本项目证明 | EXTERNAL_PRIMARY_CONFLICT，不自动调整 primary |
| 同一 Stack 含第三资产 | 任意 | STACK_HAS_OTHER_ASSETS，禁止修改 |
| 分别位于不同 Stack | 任意 | STACK_SPLIT_CONFLICT，禁止合并 |
| 仅一侧位于 Stack | 任意 | STACK_PARTIAL_CONFLICT，禁止拉出或合并 |
| 任一 Stack/成员信息未知、无权限或不一致 | 任意 | STACK_STATE_UNKNOWN，fail closed |
| 同一已登记 Stack，成员与 primary 完全匹配 | 有可靠成功证明 | REGISTERED_OBSERVED，幂等 no-op |
| 已登记 Stack 消失、成员或 primary 变化 | 有历史证明 | DRIFTED，冻结，不重建、不补偿 |
| 未知写结果后观察到目标两侧 Stack | 没有可靠响应 Stack ID | OBSERVED_EQUIVALENT_UNATTRIBUTED，不能自动认领 |

普通 Stack 的自动接管、拆分、合并、primary 调整固定禁止，不作为待选方案。用户仅选择“跳过冲突继续报告”或“遇到冲突停止该批”，两种都不写冲突 Stack。

Stack 创建请求必须精确为 [jpgAssetId, arwAssetId]，以 JPG 作为首个 primary。官方 create repository 会吸收输入 primary 所属旧 Stack 的其他资产，因此已有 Stack 不能直接传给 create。[创建 DTO](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/server/src/dtos/stack.dto.ts)、[创建事务实现](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/server/src/repositories/stack.repository.ts)。

## 7. 独立 SQLite 注册表

本节记录 B2/B3 的 SQLite 约束；实际实现位于 `src/pair-registry.ts`，默认路径为 `I:\\ai\\immich-pair\\data\\pairs.sqlite`。B0/B1 只读入口仍不会隐式打开或创建该数据库。

### 7.1 基本规则

- 数据库只属于本项目，绝不连接 Immich PostgreSQL。
- 默认路径为 `I:\\ai\\immich-pair\\data\\pairs.sqlite`；status 只读且缺库不创建，apply 才允许初始化。
- 数据库、journal/WAL/SHM、锁文件和备份都限定在批准目录。
- 本地单机单进程写者；拒绝 UNC、网络共享、同步盘假设和 reparse。
- 使用 foreign_keys=ON、synchronous=FULL；初版选择 DELETE journal，避免默认引入 WAL 文件管理。
- BEGIN IMMEDIATE 包含本地状态变更，不跨网络请求持有 SQLite 事务。
- 初次创建使用独立 registry init 命令；正常打开禁止隐式创建。
- B1 继续使用普通 Map 和纯 reducer；B2/B3 使用 Node 24 `node:sqlite`，不连接 Immich PostgreSQL。

### 7.2 Schema v1

传输和审计时间字段可以使用 ISO 字符串；pairing key 使用独立保存的 EXIF/Asset-detail localSecond。writer 生成的 digest 使用 SHA-256 小写十六进制；本节点不为所有外部摘要字段增加通用格式防御框架。UUID 在应用边界严格校验。

~~~sql
CREATE TABLE registry_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  registry_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  deployment_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  migration_digest TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE evidence_snapshots (
  evidence_digest TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source = 'IMMICH_ASSET_ORIGINAL'),
  owner_id TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  source_snapshot_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  subphase TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  contract_digest TEXT NOT NULL,
  plan_digest TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE pairs (
  pair_id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  jpg_asset_id TEXT NOT NULL,
  arw_asset_id TEXT NOT NULL,
  normalized_stem TEXT NOT NULL,
  local_second TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  evidence_digest TEXT NOT NULL REFERENCES evidence_snapshots(evidence_digest),
  state TEXT NOT NULL CHECK (state IN (
    'VALIDATED','PREPARED','PENDING','REGISTERED',
    'BLOCKED','DRIFTED','UNATTRIBUTED'
  )),
  managed_stack_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (jpg_asset_id <> arw_asset_id),
  UNIQUE (deployment_id, owner_id, jpg_asset_id, arw_asset_id),
  UNIQUE (deployment_id, managed_stack_id)
);

CREATE TABLE asset_claims (
  deployment_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  pair_id TEXT NOT NULL REFERENCES pairs(pair_id),
  role TEXT NOT NULL CHECK (role IN ('JPG','ARW')),
  PRIMARY KEY (deployment_id, asset_id),
  UNIQUE (pair_id, role)
);

CREATE TABLE authorizations (
  authorization_id TEXT PRIMARY KEY,
  grant_digest TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK (action = 'CREATE_STACK'),
  plan_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  approved_ids_json TEXT NOT NULL,
  max_writes INTEGER NOT NULL CHECK (max_writes > 0),
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','CONSUMED','REVOKED')),
  created_at TEXT NOT NULL
);

CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  pair_id TEXT NOT NULL REFERENCES pairs(pair_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  authorization_id TEXT REFERENCES authorizations(authorization_id),
  action TEXT NOT NULL CHECK (action = 'CREATE_STACK'),
  state TEXT NOT NULL CHECK (state IN (
    'PREPARED','DISPATCH_INTENT','ACKNOWLEDGED',
    'UNCERTAIN','COMMITTED','BLOCKED','CANCELLED'
  )),
  is_open INTEGER NOT NULL CHECK (is_open IN (0,1)),
  plan_digest TEXT NOT NULL,
  expected_before_digest TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_stack_id TEXT,
  response_digest TEXT,
  last_checkpoint_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX one_open_operation_per_pair
ON operations(pair_id) WHERE is_open = 1;

CREATE TABLE checkpoints (
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  observation_digest TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, seq)
);

CREATE TABLE audit_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(run_id),
  operation_id TEXT REFERENCES operations(operation_id),
  event_code TEXT NOT NULL,
  old_state TEXT,
  new_state TEXT,
  safe_details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
~~~

约束补充：

- claim 的 role/asset ID 必须与 pairs 对应字段一致，两个 claim 和 pair 在同一事务写入；用 insert/update trigger 防止不一致。
- pair 的部署、owner、两侧 ID 创建后不可变；更换 Asset 必须新建 pair。
- REGISTERED 必须同时满足 managed_stack_id 非空、有 COMMITTED operation、两条正确 claim；用事务和防非法状态触发器保证。
- managed_stack_id 仅用于可证明由本项目创建并确认的关系。外部等价 Stack 只存于观察 payload。
- 不以 stem/localSecond 建唯一约束；同 key 可能出现重复资产，必须允许审计歧义。
- 无确定结论的操作保留 claim；不能因超时释放后允许另一 pair 重用 Asset。
- checkpoint/audit 只追加；应用正常操作禁止更新或删除历史事件。
- JSON 字段只存白名单投影，不存请求 header、key、原始异常或真实照片内容。

### 7.3 状态转换

Pair：

~~~text
VALIDATED -> PREPARED -> PENDING -> REGISTERED
    |            |          |
 BLOCKED      BLOCKED    UNATTRIBUTED
                            |
                         人工复核

REGISTERED -> DRIFTED
~~~

Operation：

~~~text
PREPARED -> DISPATCH_INTENT -> ACKNOWLEDGED -> COMMITTED
                    |                |
                 UNCERTAIN <---------+
                    |
                 BLOCKED
~~~

- PREPARED 可以在未 dispatch 时取消。
- DISPATCH_INTENT 以后取消只表示停止后续动作，不表示远端回滚。
- UNCERTAIN 不自动回到 PREPARED。
- BLOCKED 是需要处理的记录，不是允许重建操作的信号。
- 恢复与重新执行是不同动作；reconcile 默认只读网络。
- 所有状态转换携带预期 revision，以条件 UPDATE 防止重复提交。

### 7.4 版本迁移

初版只实现 v1：

- user_version、registry_meta 和 schema_migrations 必须一致。
- 新于支持版本的数据库拒绝打开写模式。
- 不自动 downgrade。
- 未来迁移必须有显式 migration 命令、已关闭连接的备份或 SQLite 正式备份机制、迁移摘要、事务和迁移后验证。
- 不复制活动数据库主文件冒充一致备份。
- 损坏或未知 schema 时停止，不删除重建。
- 原始 registry 文件丢失时不能从 Stack 外观自动重建“本项目拥有”证明。

## 8. Prepare / Commit / Reconcile

### 8.1 幂等标识

使用明确规范化 JSON：对象字段排序、数组按合同排序、UTF-8、禁止 undefined/NaN，摘要与 runId/耗时无关。

~~~text
pairId = SHA256({
  domain: "immich-pair/pair/v1",
  deploymentId, ownerId, jpgAssetId, arwAssetId
})

idempotencyKey = SHA256({
  domain: "immich-pair/create-stack/v1",
  pairId, planDigest, evidenceDigest, expectedBeforeDigest
})
~~~

本地 idempotencyKey 不是服务端幂等支持，不发送虚构的 Idempotency-Key header。创建新 runId 不能绕过已有 UNCERTAIN operation。

相同 idempotencyKey 再次 prepare 时必须逐项核对 `pairId`、`deploymentId`、`planDigest`、`evidenceDigest` 和 `expectedBeforeDigest`；任一语义字段不同都 fail closed，不得静默返回幂等成功。`evidenceDigest` 必须保留在 operation 记录中，供恢复时复核。

### 8.2 Prepare

1. 验证用户授权记录、期限、操作、Asset ID 集合、planDigest 和最大写入次数。
2. 重新计算 manifest 文件摘要、语义摘要和当前 ruleVersion。
3. 重新读取 users/me、目标 Asset、相关 Stack 和必要的完整性证据。
4. 验证 source snapshot 与原文件证据尚未失效。
5. 取得同一 registry/deployment 的独占本地执行锁。
6. SQLite 短事务写 pair、claims、PREPARED operation、checkpoint、审计。
7. 若已有相同 operation，则返回其当前状态，不插入第二个。
8. 退出事务后再次验证临近 dispatch 的远端前置状态。

### 8.3 Dispatch 与 Commit

1. 本地短事务将 PREPARED 改为 DISPATCH_INTENT，原子消费一次授权额度并追加 checkpoint。
2. 确认提交成功后，仅发送一次精确的 POST /api/stacks。
3. 正常 201 响应校验后，先把 response stack ID 与摘要持久化为 ACKNOWLEDGED。
4. 使用独立只读请求复查两侧 Asset 和 Stack。
5. 只有 ID、成员、JPG primary、owner、前后证据全部符合时，事务提交 REGISTERED / COMMITTED。
6. 报告从提交后的注册表投影生成；报告写失败不撤销已经确认的远端 Stack。

### 8.4 崩溃点和恢复

| 崩溃点 | 恢复动作 |
| --- | --- |
| PREPARED 事务前 | 没有操作记录；重新准备 |
| PREPARED 已提交、dispatch intent 前 | 可重验后继续；不直接发送 |
| DISPATCH_INTENT 已提交、实际发送前 | 无法可靠区分是否发送；按 UNCERTAIN 处理 |
| 远端成功、本地未保存响应 | 只读 reconcile；禁止重发 create |
| ACKNOWLEDGED 已持久化、最终提交前 | 按保存的 Stack ID 复查后完成本地提交 |
| COMMITTED 后、报告前 | 从 registry 生成新的恢复报告，不重复远端操作 |

reconcile 结果：

- 有持久化 response ID 且远端完全符合：可完成本地提交。
- 无 response ID，恰好观察到目标 Stack：结果等价但来源未证明，UNATTRIBUTED。
- 两侧仍无 Stack：不能证明原请求不会迟到，保持 UNCERTAIN。
- 其他 Stack、第三成员、primary 变化：BLOCKED/DRIFTED。
- 401/403/400/404 或读取失败：无法判定，不当作“远端未执行”。

禁止自动 DELETE 补偿。若已经影响普通 Stack，报告具体差异并停止；不自行“修复回原状”。

### 8.5 并发限制与 B3 阻塞条件

本地锁只防本工具并发。服务端 create 未提供本设计可用的以下机制：

- expected stack 状态条件。
- ETag/If-Match 比较并创建。
- 客户端指定 Stack ID。
- 已验证的服务端幂等 key。

因此，“读到 NONE → create”之间仍可能被 Web/mobile/其他任务改变，导致官方 create 合并普通 Stack。

当前 batch coordinator 按 `LOCAL_SINGLE_USER_SINGLE_WRITER`、并发 1 和逐对 fresh read 执行完整 batch；这些是本地产品边界与风险降低措施，不是服务端 CAS。batch live transport 仍保持关闭，batch CLI 仅允许 mock；只有独立的单 pair `live-smoke` 在用户确认完整绑定后可用，并已于 2026-09-13 完成一次真实验证。未来任何 live apply/smoke 仍必须由用户另行确认具体 plan、运行时凭据、confirmation 和 TOCTOU 风险；不能把 mock 或一次 smoke 通过宣称为消除竞态。

本节点不修改 Immich 服务端、Compose 或容器来解决这个问题。

### 8.6 重试分类

- 只读 GET 与 metadata POST：对明确瞬时 fetch/正文流网络失败、429、部分 5xx 最多重试两次，总调用不超过三次；每次 attempt 的 timeout 覆盖该 attempt 的 fetch 与 bounded body read，但不是跨全部 retry/backoff 的总 deadline。公开接口不返回 raw `Response`，所有允许 read 都经过正文大小和 attempt timeout 边界。
- 401/403、schema 错误、资源级 400、404、redirect：不自动重试。
- 所有真实 create：dispatch 后不自动重发，包括 429/5xx、连接中断、超时、成功码但响应损坏。
- 只有在网络适配层被调用前确定拒绝的操作，才可在修正条件后重新 prepare。
- 无关批次不绕过同 Asset 的 unresolved claim。

## 9. 模块与 API Contract

| 文件 | 职责 | 子阶段 |
| --- | --- | --- |
| src/phase-b-contracts.ts | B 领域类型、状态枚举、manifest 类型 | B0/B1 |
| src/immich-v310-adapter.ts | 官方响应运行时校验、wire 到内部模型映射 | B0 |
| src/credential-provider.ts | 非持久化凭据入口 | B0 |
| src/phase-b-config.ts | 无秘密配置、显式范围 | B0 |
| src/phase-b-read-policy.ts | 精确只读 allowlist；original 强制关闭 | B0 |
| src/phase-b-read-client.ts | x-api-key、超时、有限只读重试 | B0 |
| src/phase-b-inventory.ts | 正确分页、owner/library 分区、两遍观察 | B1 |
| src/stack-observer.ts | detail 复查、UNKNOWN/NONE/PRESENT、冲突矩阵 | B1 |
| src/registration-protocol.ts | 纯 reducer、Map 模拟、崩溃状态演练 | B1 |
| src/phase-b-report-writer.ts | 新 manifest、不可执行报告 | B0/B1 |
| src/original-evidence.ts | 明确映射后的原文件证据链 | B2，另授权 |
| src/stack-write-plan.ts | B1 detail 重验、唯一 pair batch plan、digest | B2 |
| src/pair-registry.ts | SQLite schema、claims、attempt、receipt、checkpoint、journal | B2 |
| src/stack-write-client.ts | 固定窄 create transport、严格 receipt validator、offline mock | B3 |
| src/stack-write-policy.ts | mock gate、确认 digest、runtime capability | B3 |
| src/stack-registration.ts | prepare/fresh read/dispatch/post-read/resume/reconcile | B3 |

建议稳定内部接口：

~~~ts
interface ImmichReadonlyGateway {
  getVersion(): Promise<VersionObservation>;
  getMe(): Promise<IdentityObservation>;
  getLibraries(): Promise<LibraryObservation[]>;
  searchPage(query: MetadataQuery310): Promise<ValidatedSearchPage>;
  getAsset(id: string): Promise<AssetObservation>;
  getStack(id: string): Promise<StackObservation>;
}

interface RegistrationModel {
  prepare(input: ValidatedPrepareInput): TransitionResult;
  recordDispatchIntent(operationId: string): TransitionResult;
  recordAcknowledgement(input: Acknowledgement): TransitionResult;
  reconcile(input: ReconcileObservation): TransitionResult;
}

type GateResult =
  | { allowed: false; reasons: string[] }
  | { allowed: true; capability: StackWriteCapability };
~~~

StackWriteCapability 只能由运行时 gate 内部创建，不能由 JSON 反序列化得到。B0/B1 不提供真实 capability 构造路径，也不导入真实写 transport。

现有 A contracts/planner/report 保留。不能将真实 Asset 转成伪造 LOCAL_SAMPLE 输入来复用 planner；如后续抽取纯规则核心，保留 A wrapper 和报告字节语义，针对差异增加最小回归。

B2/B3 已在现有 `src/cli.ts` 增加 `batch preview|plan|apply|resume|status` 及等价短别名；SQLite 使用 Node 24 内置 `node:sqlite`，未增加 npm 依赖。batch 仍不接入真实 live transport；隔离的单 pair `live-smoke` 已完成一次真实写入与零 POST 恢复验证，不能据此扩大为 batch live 授权。

## 10. 报告与执行门禁

每次独占创建新 run 目录，UTF-8 LF：

~~~text
compatibility.json
assets.jsonl
stack-observations.jsonl
registration-plan.jsonl
issues.jsonl
manifest.json
~~~

manifest 最后写入，至少包含：

~~~ts
interface PhaseBManifest {
  manifestVersion: 2;
  phase: "B";
  subphase: "B0" | "B1" | "B2" | "B3";
  source: "IMMICH_METADATA" | "IMMICH_ASSET_ORIGINAL" | "SYNTHETIC";
  mode: string;
  runId: string;
  status: "COMPLETED" | "COMPLETED_WITH_ISSUES";
  executable: false;
  canBeUsedForStackWrite: boolean;
  serverVersion: string;
  sourceCommit: string;
  contractDigest: string;
  ruleVersion: string;
  scopeDigest: string;
  sourceSnapshotDigest: string | null;
  evidenceDigest: string | null;
  planDigest: string;
  snapshotGuaranteed: false;
  gateFailures: string[];
  files: Array<{ path: string; bytes: number; sha256: string }>;
}
~~~

规则：

- B0/B1、SYNTHETIC、仅 metadata 来源：canBeUsedForStackWrite=false。
- A manifest 永远不被接受。
- executable=false 表示报告本身不是授权或命令。
- 任何磁盘中的 canBeUsedForStackWrite=true 都只是产生时的计算结果，执行时必须重新检查，不信任该布尔值。

允许 true 必须同时满足：

1. 来源是新的真实 IMMICH_ASSET_ORIGINAL 证据。
2. 版本与冻结适配器匹配，required schema 校验通过。
3. ruleVersion、完整文件摘要及语义 digest 可复核。
4. 真实 owner、Asset ID、library 范围与授权一致。
5. 完整性、原文件关联、原始 EXIF、内容稳定性均验证。
6. Stack 状态明确，普通 Stack 保护通过。
7. SQLite 已授权、完整且无 unresolved operation/冲突 claim。
8. 独立 Stack 写授权存在、未过期，绑定精确计划和目标 ID。
9. 权限要求满足且身份未变化。
10. 服务端并发安全前提已证明。
11. 当前进程重新 prepare 后生成能力对象。

按本次已知事实，第 10 项未解决，因此当前设计不允许真实计划获得 true。

摘要只能发现修改，不能证明谁授权。authorization.json 之类文件不得被当作用户授权的唯一信任根；主代理需要保留真实批准记录并将精确范围交给执行进程。

## 11. CLI 与退出码

命令草案；尚不存在，不能作为已可运行命令交付：

~~~text
phase-b compat --config <no-secret-json>
phase-b inventory --config <no-secret-json>
phase-b protocol-check --fixture <project-synthetic-fixture>

phase-b registry init --db <approved-absolute-path>
phase-b registry inspect --db <existing-approved-path>
phase-b prepare --manifest <fresh-b-manifest> --db <approved-path>
phase-b stack-commit --operation <id> --approval <approval-reference>
phase-b reconcile --operation <id> --db <approved-path>
~~~

B0/B1 CLI 对 registry init、prepare、stack-commit 明确返回阶段禁止，不能静默 no-op 成功。

沿用 A 0、2–6 意义，新增：

| 码 | B 含义 |
| --- | --- |
| 0 | 请求范围已完整处理且无 issue；不代表已创建 Stack |
| 2 | 完整报告含冲突、不可验证项或阶段外能力 |
| 3 | inventory/证据观察不完整或变化 |
| 4 | 配置、凭据入口或 extractor 不可用 |
| 5 | 路径、网络 policy、阶段边界拒绝 |
| 6 | 报告持久化失败 |
| 7 | 认证/权限不足 |
| 8 | 版本或 schema 不兼容 |
| 9 | 注册表 schema、完整性或本地锁问题 |
| 10 | 尚无有效执行授权或执行门禁未通过 |
| 11 | 已有可能 dispatch 的不确定远端结果，需 reconcile |

报告失败与远端不确定同时发生时优先 11，并以固定脱敏错误说明报告也失败。其余优先保留根因，报告错误作为补充，不把所有失败压成一个 exit 2。

## 12. 敏感信息与路径边界

- 所有真实凭据不得写入文档、报告、源码、测试、日志或记忆。
- 测试仅使用明显无效的合成 sentinel，不使用真实 key。
- 日志只记录固定 endpoint 模板、状态码、内部错误码、run/operation ID、耗时和白名单摘要。
- 不打印原始响应 body、header、完整用户对象、email、底层异常或命令行。
- 路径报告使用 mapping ID、相对路径或 digest；绝对 originalPath 不默认进入共享报告。
- 非敏感 UUID 可用于审计；不能以脱敏到无法区分 Asset 的方式破坏恢复能力。
- 从 API 返回 originalPath 字符串不是访问文件授权；不得对 protected root 执行 stat/lstat/realpath 以“确认存在”。
- I:\photos\unmodified、/mnt/photos 先做词法拒绝，不触发文件系统调用。
- 原文件允许根、report、temp、SQLite 及副文件目录两向互斥。
- 拒绝 UNC、device path、ADS、路径穿越、尾部点/空格及 reparse/junction。
- 映射按完整路径段匹配，不使用字符串 startsWith 模糊前缀。
- EXIF 子进程继承 A 的参数数组、shell=false、-config NUL、-G1:4、只读字段和原时间解析规范。
- 不修改 Immich、Compose、容器、全局配置、PATH 或环境变量持久设置。

## 13. 测试与完成条件

新增最多三条解释清楚的 smoke/critical 流程，详见验收文档：

1. v3.1.0 wire → B 只读报告。
2. Stack 状态矩阵 → 注册协议 reducer。
3. 未授权能力与崩溃恢复；B2 获权后扩充该条为实际 SQLite 恢复证据。

保留现有稳定测试。只为已发现的 bug 或具体数据安全不变量增加最小回归，不扩展完整故障、性能、兼容、打包或发布矩阵。

B0/B1 完成不要求真实 Stack 写入、真实照片 EXIF 或 SQLite。实际缺少 key/owner/library 时，必须明确区分 OFFLINE_IMPLEMENTED 与 LIVE_READ_VERIFIED，不能用前者冒充后者。

## 14. B/C/D 边界

- B：后端契约、只读观察、证据、注册表、恢复协议，以及另授权后的 Stack 创建。
- C：查看器、JPG/RAW 切换、关系展示及解除 UX；本节点不做前端。
- D：逐侧删除、Trash、恢复、永久删除；本节点不调用这些接口。
- Stack delete 是关系操作，不是 Asset 删除授权；首次 B3 create 也不包含解除关系授权。
- 禁止借“回滚”“清理”“恢复测试”进入 C/D 或真实照片删除。
