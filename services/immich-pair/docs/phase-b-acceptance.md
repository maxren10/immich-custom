# Phase B 验收合同

版本：2026-09-12
状态：验收合同；B0/B1 离线实现与 B2/B3 batch mock 回归证据见 phase-b-handoff.md，以下清单仅按实际命令和证据复核后打勾。
参考：phase-b-design.md、phase-b-decisions-needed.md 和 Phase A 基线。

> 当前口径：`LOCAL_SINGLE_USER_SINGLE_WRITER`、完整 batch、并发 1。本文早期“B2/B3 另行授权/仅 canary”条目是历史 B0/B1 基线；当前 B2/B3 实际代码和三条目标测试以 `phase-b2-b3-stack-write-design.md` 为准。真实 live POST 仍关闭。

## 1. 验收层级

必须分别报告：

- DESIGN_READY：设计、真实待决策项和验收合同齐备。
- OFFLINE_IMPLEMENTED：合成数据、mock 网络和纯协议实现通过。
- LIVE_READ_VERIFIED：选定身份与 library 的真实只读调用验证。
- REGISTRY_VERIFIED：另授权后的实际 SQLite 持久化和恢复验证。
- ORIGINAL_EVIDENCE_VERIFIED：另授权后的原文件证据链验证。
- STACK_WRITE_VERIFIED：独立批准的具体写入及 reconcile 完成。

层级之间不自动升级。DESIGN_READY 不表示 Phase B 已实现。

## 2. B0 验收

- [ ] 冻结官方 v3.1.0 commit 与接口来源；不用本机 404 OpenAPI。
- [ ] B API key 使用 x-api-key，凭据由已选择的非持久化入口提供。
- [ ] 不读取 .env，不接受秘密配置文件或命令行明文 key。
- [ ] users/me 的 id 与显式 owner 一致；不自动推断身份。
- [ ] 正确处理 library.read 的 admin 限制。
- [ ] metadata 请求不发送 ownerId；响应使用 assets.items / assets.nextPage。
- [ ] nextPage 严格转换为正整数 page；不直接传任意字符串。
- [ ] Asset libraryId 的缺失/null/UUID 三种情况有明确处理。
- [ ] 不把搜索结果省略 stack 当作无 Stack。
- [ ] 400、401、403、404、5xx 和 schema 错误分开归类。
- [ ] 请求有超时、响应大小与有限重试限制，redirect 被拒绝。
- [ ] 原始照片 API 和所有写 endpoint 在 fetch 前被拒绝。
- [ ] report 的可执行资格为 false，秘密 sentinel 不出现在输出。

真实认证验收未进行时，只能标记 OFFLINE_IMPLEMENTED，不勾选真实 owner/library 已验证。

## 3. B1 验收

- [ ] 完整跟随所有分页；重复 ID、循环和非法 schema 产生 INCOMPLETE。
- [ ] 所选 owner/library 范围可复核；partner owner 不混入。
- [ ] 两遍稳定只记录观察稳定，snapshotGuaranteed 始终 false。
- [ ] 对所需 Asset 获取 detail，区分 UNKNOWN/NONE/PRESENT。
- [ ] Stack 观察包括成员、primary、assetCount 和完整性限制。
- [ ] 普通 Stack 不被认领，外部等价 Stack 只观察。
- [ ] 同 Stack、不同 Stack、第三资产、单侧 Stack、未知状态全部有确定分类。
- [ ] 配对规则 key 不包含 directory/library/hash 等审计字段。
- [ ] metadata search 保持 `withExif=false` 并生成 `NOT_READ` original-time evidence；经过验证的 Asset detail 才能从 `exifInfo.dateTimeOriginal` 生成 `VERIFIED`，不能使用 `localDateTime` fallback。
- [ ] Asset detail 的 explicit-offset ISO 时间结合已识别 `UTC±H`/`UTC±HH:MM` 重建 localSecond；无效时区、缺失时间和矛盾字段 fail closed。
- [ ] JPG/JPEG 与 ARW/DNG 使用同一个 RAW 兼容槽位；恰好一 JPG + 一 RAW 为 `CANDIDATE`，重复同侧为 `AMBIGUOUS`，配对计划不可执行且不能用于 Stack write。
- [ ] `B1_DETAIL_ENRICHMENT_PLAN` 只接受 COMPLETE + TWO_PASS_STABLE 且全为 SEARCH/NOT_READ 的 inventory；其他输入整体 BLOCKED、requests 为空。
- [ ] detail 预筛只按 owner + NFC lowercase stem；跨 library 合并，同 stem 的全部跨角色资产（包括重复同侧）都保留；单侧和其他扩展名排除。
- [ ] 离线计划不执行 GET，requests 和 groups 稳定排序，digest 与输入顺序无关；plan/request 均为 `executable=false`、`canBeUsedForStackWrite=false`，并要求显式 live-read authorization。
- [ ] `PhaseBDetailRequest.libraryId` 同时进入 plan digest、`run.json` frozen binding 和 resume 比较；detail gateway 只暴露 `getAsset`，不能调用 `getStack`。
- [ ] detail client 的 `maxRetries=0`；4,488 cap 按实际 detail HTTP dispatch attempt 计，不能按唯一 Asset ID 或隐式 retry 计数。
- [ ] cap 不超过 4,488、batch 不超过 100、并发不超过 2；计划超过 cap 或参数越界时，在创建 run/checkpoint、reservation 和任何 GET 前返回 `STOPPED_BUDGET`。
- [ ] checkpoint 新 run 只写 v2；v1 和 frozen plan over-cap 在 resume 零 dispatch、零新增文件 fail closed，不做隐式迁移。
- [ ] 每次可能的 batch dispatch（包括已有未完成 reservation 的恢复重发）前都有新的不可回退 reservation；checkpoint 读取/提交验证 frozen slice、合法唯一 batch index、逐项唯一 `dispatchAttempted=true`、成功 DETAIL/source/id/owner/name/library 绑定和失败 reason allowlist；resume 保守累计所有历史 reservation，`reserveBatch` 与读取入口都拒绝 aggregate over-cap，不能部分调度或自动新建 run。
- [ ] fresh reportDir 与 resumeRunDir 使用 Windows lexical/absolute/ADS/UNC/device/traversal 和 existing-ancestor reparse/junction guard；resume 只能是输入 reportDir 的直接子目录且 basename 等于 frozen runId。run/child JSON 必须是普通文件，reservations/batches 必须是普通目录；每次 checkpoint 写前重检父目录、目标和现有祖先。句柄级 TOCTOU 为明确 residual risk。
- [ ] 401 后不再调度新 request，最多等待另一个已在途 request；`dispatchedAttempts===committedDispatchedAttempts`，本次未提交观察数单列 `observedUncommittedAttemptsThisInvocation`；其它固定 detail 失败分类继续完成当前 batch。
- [ ] 完整性入口只接受 frozen plan + outcomes；任一失败、未调度、binding mismatch 或非 VERIFIED 时间都使整 stem 无 CANDIDATE，成功 detail 仍保留在结果报告。
- [ ] A 报告输入不能进入 prepare，更不能翻转原 manifest 字段。
- [ ] 注册协议在 Map/纯 reducer 中验证，无 SQLite 驱动调用。
- [ ] 所有 B0/B1 manifest 的 canBeUsedForStackWrite=false。
- [ ] registry/stack 写命令返回明确阶段拒绝，不隐式创建文件。

## 4. 三条 smoke/critical 测试

### T1：官方 wire 到只读报告

使用冻结 schema 的最小合成响应及 mock fetch，完成：

- 正确 x-api-key 注入，但不打印 header。
- users/me、library、两页 metadata、asset detail、stack detail。
- 同 owner 多 library 输入正确合并；partner owner 明确排除。
- 正确处理搜索缺失 stack 与 detail 明确 null 的差别。
- Asset detail 时间样例 `2026-02-16T03:53:27+00:00` + `UTC+9` 重建 `2026-02-16T12:53:27`；缺少 `dateTimeOriginal` 时不使用 `localDateTime`。
- JPG+ARW、JPG+DNG、重复 RAW 和 detail/search original-time evidence 的最小变体通过纯函数配对测试。
- detail-plan 最小影响基线记录为旧报告 7,083 行：JPG 3,746、RAW 3,337、两侧 stem group 1,803、唯一一对 group 1,360、重复同侧 group 443、预计 4,488 个 detail GET；不得将 2,720 当作完整范围。
- 使用非法 nextPage、重复 ID 或缺失 required identity 字段的最小变体，验证失败关闭。
- 写出独占 run、JSONL 和最后 manifest，复算文件摘要。
- 所有资格标志保持 false，输出不含秘密 sentinel。
- detail runner 合成回归覆盖 dispatch cap/零 retry、library binding、整 stem failure gate、401 stop 与未提交字段、reservation budget、未完成 reservation 恢复时新增 reservation 且不突破 cap、v1/aggregate-over-cap 零 dispatch零新增文件、真实 directory junction 与普通 child/entry 类型拒绝、完整 batch resume、orphan `.tmp` 忽略和 plan/library 变化时零 detail；另覆盖 over-cap/越界参数零 dispatch、合法 JSON 的错误 frozen binding 零 dispatch、外部 resume 路径，以及 live/top-level/phase-b sensitive/unknown CLI token 不回显。

不访问本机 Immich 和任何照片路径。

### T2：Stack 保护与协议转换

以表驱动合成观察覆盖：

- 两侧 NONE。
- 同一普通 Stack、正确 primary。
- 同一普通 Stack、错误 primary。
- 不同 Stack。
- 第三资产。
- 单侧 Stack。
- 未知或不一致状态。
- 已登记匹配与已登记 drift。

断言：

- 普通 Stack 无论是否等价都不自动接管。
- 冲突不会产生 write capability。
- 相同幂等 key 不创建第二条 operation。
- 同 Asset 不被第二个 pair claim。
- library/directory 改变不改变匹配 key。
- 已知 CANDIDATE 与执行 eligibility 独立。

### T3：阶段门禁与不确定结果恢复

首轮使用 Map 和 fake transport：

- 未授权时 SQLite factory、original reader 和 write transport 的调用计数均为零。
- protected root 在词法检查拒绝，不调用 stat/lstat/realpath。
- PREPARED 后重启模型可重验。
- DISPATCH_INTENT 后模拟丢响应，进入 UNCERTAIN；不能自动重发。
- 仅观察到等价 Stack、没有可靠 response ID 时保持 UNATTRIBUTED。
- ACKNOWLEDGED 且远端符合时只完成本地提交。
- 报告失败不会触发远端补偿删除。

B2 获得授权后，在同一测试流程中加入项目内临时 SQLite：

- 事务回滚不留下半个 pair 或单侧 claim。
- 重开数据库保留 checkpoint。
- 唯一约束阻止重复占用。
- 未知 schema 拒绝写入。
- 不连接 Immich PostgreSQL。

这不是启动完整故障矩阵的授权。

## 5. 现有回归与命令证据

保留全部已有稳定测试，主代理运行并汇总：

~~~powershell
npm run typecheck
npm run test:critical
npm test
~~~

必须记录实际 exit code、tests pass/fail 和本次构建产物范围。不得复制 A 的测试数量宣称 B 已通过。

本轮实现变更后的实际命令结果记录在 phase-b-handoff.md；后续增量变更仍须更新实际 exit code、测试数量和产物范围。

无 Git 时，以批准文件清单和文件摘要检查，不因此阻塞。

## 6. 真实只读验收

仅在 D2/D3 及条件性的 D4 落实后：

- [ ] GET ping/version，记录本次实际值。
- [ ] GET users/me，确认 owner。
- [ ] 使用经批准的发现身份验证 libraries。
- [ ] metadata 只读分页及目标 detail schema 校验。
- [ ] 真实响应只保留脱敏白名单投影。
- [ ] 未读取原文件或 original endpoint。
- [ ] 未发送 Stack/Asset/Library/Job/Trash 写请求。
- [ ] 版本、权限或 schema 不符时报告实际阻塞，不自动改配置。

“四服务 healthy、RW 外部库、open-api 404”若沿用任务交接，需要明确标记为交接事实，而非本轮 live observation。就本项目当前记录而言，四服务 healthy、ping/version 成功及 open-api 404 已由主代理在本轮实时验证；Astra 未自行验证，不能把这些证据归属于 Astra。

## 7. B2 条件性验收

只有对应能力获授权才执行：

- [ ] 用户选定 SQLite 路径与创建时点。
- [ ] 正常打开不隐式创建，init 不覆盖现有文件。
- [ ] v1 schema、claims、open operation 唯一性、状态触发器有效。
- [ ] DB 和副文件均位于允许目录。
- [ ] 网络调用不发生在 SQLite 事务内。
- [ ] checkpoint/audit 可从重启后读取。
- [ ] 数据库损坏或版本不支持时拒绝，不删除重建。
- [ ] 原文件读取另有明确批准；只有数据库授权时仍不读取照片。
- [ ] Asset → 显式路径映射 → 原文件摘要 → EXIF → 读后复核链路可复算。
- [ ] 内容摘要和 library 只作为证据，不进入 pairing key。
- [ ] 源变化、关联歧义、范围不完整时执行资格为 false。

## 8. B3 首次写入门禁

当前状态：未授权，且服务端并发安全前提未解决。

未来必须全部成立：

- [ ] B0/B1 实施与真实只读证据齐备。
- [ ] B2 实际注册表与原文件证据验收完成。
- [ ] 解释并解决 v3.1.0 create 合并已有 Stack 的竞态。
- [ ] 用户针对新的精确 manifest 单独授权。
- [ ] 授权绑定一个 owner、一个 JPG ID、一个 ARW ID、CREATE_STACK、最大一次 dispatch 和有效期。
- [ ] 双方没有普通 Stack，相关状态完整可验证。
- [ ] 无 unresolved operation 或 claim 冲突。
- [ ] create 请求恰好 [JPG_ID, RAW_ID]；RAW 可为 ARW 或 DNG，兼容字段名仍可为 `arwAssetId`。
- [ ] 写后独立 GET 复核并提交 checkpoint。
- [ ] 不确定结果进入 reconcile，不自动 create 重试。
- [ ] 没有 update/delete/Asset/Trash/文件写入作为补偿。
- [ ] 完成报告区分远端结果、本地提交与报告生成状态。

任何一项不成立，canBeUsedForStackWrite 必须为 false。

## 9. Review 输入与完成条件

主代理提交精简交接包：

- 用户批准的子阶段与未批准能力。
- 目标、不变量和批准文件范围。
- 变更摘要及 diff；无 Git 时提供文件清单。
- 实际测试结果。
- 真实只读调用结果与未验证事项。
- 已知限制，尤其服务端竞态和成员可见性。
- 少量核心文件路径。

Review 只读。发现问题按严重程度、文件/符号、证据、影响和建议报告；局部问题修复后只复查增量和受影响测试。

完成判定：

- B0/B1 Functional Complete：主流程和关键安全不变量有实际合成证据；需要真实验收的部分必须明确是否已验证。
- SQLite、原文件、Stack 写入未授权不影响只读子阶段独立交付，但不能声称这些能力完成。
- 不开展 C 前端、D 删除、性能、完整 fault/recovery 矩阵或发布验收。
