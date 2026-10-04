# JPG/RAW（ARW 或 DNG）Pair 产品需求

版本：A 阶段第二轮文档基线（2026-09-10）

本文是功能需求接口。它描述完整产品目标和各阶段门槛；没有获得对应阶段授权时，B/C/D 只允许补充文档、契约和测试，不得实现其写入或破坏性行为。

## 1. 产品目标

在 Immich 的两个独立 Asset 之间建立一组可审计的 JPG/RAW 配对关系，让用户把同一次拍摄的 JPEG 预览和 ARW/DNG 原始文件作为一个逻辑单元查看和管理，同时保留 Immich 原有 Asset 生命周期和升级路径。

产品必须满足：

- JPG/JPEG 和 RAW（ARW 或 DNG）仍然是两个独立的 Immich Asset；不会把二进制合并成一个文件，也不会直接改 Immich PostgreSQL。
- 已确认的关系使用 Immich 原生 Stack 表达，JPG/JPEG 是 primary，RAW（ARW 或 DNG）是 secondary。
- 查看逻辑默认展示 JPG；在查看器内可以明确切换到已配对的 ARW。切换不是重新匹配，也不能凭文件名临时猜测。
- 删除入口必须明确显示 JPG 与 ARW 两个角色，并让用户选择删除哪一侧或两侧。
- Stack 不能被当作级联删除协议：删除 JPG 不得未经用户选择自动删除 ARW，删除 ARW 也不得未经选择自动删除 JPG。
- 配对、证据、冲突、删除/恢复操作必须可审计；未验证、歧义和失败状态不得伪装成已配对。

## 2. 配对规则（用户锁定，不可加严或改变）

对每个候选文件使用以下唯一规则：

1. `owner` 相同。
2. basename 只去掉最后一个扩展名；Unicode 规范化后忽略大小写。
3. A 阶段使用原始媒体文件 ExifIFD `DateTimeOriginal` 的本地年月日时分秒；B Asset detail 使用带显式 offset 的 `exifInfo.dateTimeOriginal`，结合已验证 `timeZone` 重建本地墙钟秒。两者都忽略亚秒，不能把 UTC instant 直接当作配对 key。
4. 同一 `(owner, normalizedStem, localSecond)` 恰好有一个 JPG/JPEG 和一个 RAW（ARW 或 DNG）。

以下字段可以保留为审计证据，但绝不能改变 `CANDIDATE` 判断：directory、library、camera model、serial、hash。跨目录、跨 library 仍可配对。多个同 role 同 key 必须是 `AMBIGUOUS`；缺失或无效原始时间必须是 `UNVERIFIED`，绝不回退 mtime、ctime 或任意未验证的时间字段。

A 阶段的正式时间证据仍是原文件 ExifIFD `DateTimeOriginal`。新增的 B0/B1 只读节点允许把经过冻结 Immich v3.1.0 adapter 验证的 Asset detail `exifInfo.dateTimeOriginal` 作为正式的 Immich original-time evidence：它必须带显式 `Z`/offset，并结合已识别的 `UTC±H`/`UTC±HH:MM` `timeZone` 重建本地墙钟秒；`localDateTime` 只能一致性校验，不能 fallback。metadata search 的 `withExif=false` 结果永远是 `NOT_READ`。不认识的时区、无效日期或矛盾字段均不得产生候选。

## 3. 数据与关系模型

### 3.1 Immich 侧（未来阶段）

- 两个独立 Asset：`JPG/JPEG` 与 `RAW（ARW/DNG）`。
- 一个原生 Stack：JPG primary，ARW secondary。
- 只通过 Immich 官方 API 和明确授权的写流程操作 Stack/Asset；永远不直接连接或写 PostgreSQL。
- 普通用户已有的 Stack 不得被自动接管。目标关系的创建、解除、幂等性、并发冲突和恢复语义必须在 B/C 阶段单独验收。

### 3.2 独立配对数据库（未来阶段）

- 配对注册表是 `I:\ai\immich-pair` 自己管理的独立 SQLite 数据库，不是 Immich 数据库。
- SQLite 记录 Pair、双方 Asset 标识、匹配规则版本、证据 digest、操作状态和恢复检查点。
- A 阶段不得创建正式 SQLite/pair DB；A 阶段报告是唯一持久化交付物。
- 任何需要同时改变 SQLite 与文件/Immich 状态的操作，必须先通过独立阶段设计解决崩溃恢复、幂等和不一致，而不是在 A 阶段偷偷引入事务假设。

## 4. 阶段范围和门槛

### A：本机只读样本与可审计 dry-run

本轮范围：

- 只允许显式 `sampleRoot` 位于 `I:\photos\PHOTOMANAGER_TEST` 内；本轮测试只使用合成 fixture，主代理另行执行真实目录 dry-run。
- 使用显式配置的 ExifTool 读取原始 EXIF；只读枚举 JPG/JPEG/ARW/DNG；按锁定规则生成不可执行 pairing plan。
- 输出 `assets.jsonl`、`pairs.jsonl`、`issues.jsonl` 和最后写入的 `manifest.json`。
- 报告 `mode=LOCAL_SAMPLE_DRY_RUN`、`source=LOCAL_SAMPLE`、`executable=false`，并明确 `canBeUsedForPhaseB=false`。
- 不调用 Immich 写 API、不访问 PostgreSQL、不创建/解除 Stack、不删除/恢复 Asset/Trash、不创建正式 SQLite。

A 阶段完成门槛：文档契约、关键测试、类型检查、全量测试全绿；合成报告能证明原始时间到报告的链路和核心数据安全 invariant；真实 dry-run 由主代理在本轮之后使用精确配置执行，并单独记录证据。

### B：真实只读兼容与可恢复注册（未授权，仅记录需求）

- 验证真实 Immich 版本的只读 Asset/owner/library/schema 兼容性。
- B1 detail enrichment 先生成离线 `B1_DETAIL_ENRICHMENT_PLAN`：只对完整、两遍稳定 inventory 中同一 owner/stem 同时存在 JPG 与 RAW 的全部相关资产提出 detail request；计划不执行请求，且必须标记 `requiresLiveReadAuthorization=true`、`executable=false`、`canBeUsedForStackWrite=false`。
- 当前既有 7,083 行报告的离线影响基线为 JPG 3,746、RAW 3,337、两侧 stem group 1,803、唯一一 JPG+一 RAW group 1,360、重复同侧 group 443，未来全量补证预计 4,488 个 Asset detail GET；这不是已执行的 live detail 结果，2720 不是完整范围。
- 解决真实部署中的 Exif 来源、普通 Stack 保护、Stack 创建幂等/不确定结果和独立 SQLite 注册表恢复协议。
- A 阶段报告不能直接变成 B 阶段执行输入；必须重新验证源快照、规则版本、权限和 digest。
- 未获得明确授权前，不实现数据库、Stack 写入或任何执行 worker。

### C：查看器和 Stack 关系 UX（未授权，仅记录需求）

- JPG primary 预览；用户可查看并切换到已配对 ARW。
- 关系展示、取消/冲突提示和普通 Stack 隔离必须可解释。
- 只允许经过 B 阶段注册和幂等验证的关系进入写流程。
- 未获得授权前，不修改 Immich Web/mobile/frontend，不创建或解除 Stack。

### D：明确角色删除、Trash 和恢复（未授权，仅记录需求）

- 删除确认框逐侧显示 JPG 与 ARW，用户可选 JPG、ARW、两者或取消。
- 不依赖 Stack 级联语义；每一侧状态、Trash、恢复和永久删除必须独立可验证。
- 必须有操作检查点、重启恢复、权限失败和文件/数据库不一致处理。
- 未获得授权前，不调用删除、恢复、Trash、清空 Trash 或文件删除 API。

## 5. 安全和操作边界

- 只修改 `I:\ai\immich-pair`。不得修改 `I:\ai\photo_manager`、`I:\ai\immich`、Compose、容器、数据库或全局配置。
- `I:\photos\PHOTOMANAGER_TEST` 是唯一允许的真实样本根；不得访问 `I:\photos\unmodified` 和 `/mnt/photos`。
- 样本根只读，拒绝 symlink、junction 和其他 reparse point；输出/临时目录不得与样本根或 protected roots 互相包含。
- 不保存 API key、Authorization header 或二进制到报告；A 阶段可以完全不调用 Immich。
