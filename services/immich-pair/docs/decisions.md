# 决策记录

本文按日期记录用户已经锁定的决策。实现代理必须先读本文、`product-requirements.md` 和阶段设计；当前 prompt 只能补充而不能悄悄覆盖这些锁定项。

## 2026-09-10 — A 阶段第二轮实施边界

- 项目独立位于 `I:\ai\immich-pair`，使用 TypeScript；不得把实现迁回 `I:\ai\photo_manager` 或 `I:\ai\immich`。
- A 阶段是本机只读 dry-run。第一轮只读 Immich contract 保留，但本轮本地样本链路可以完全不调用 Immich。
- 唯一允许的真实样本根是 `I:\photos\PHOTOMANAGER_TEST`。本轮实现和测试只使用合成/虚拟 fixture；真实目录由主代理最后执行。
- `I:\photos\unmodified` 和 `/mnt/photos` 是 protected roots，禁止访问、枚举和写入。
- 匹配规则锁定为：同 owner；basename 只去掉最后扩展名，Unicode 规范化后忽略大小写；A 原始 ExifIFD 使用其本地秒，B Asset detail 使用 `exifInfo.dateTimeOriginal` 加已验证 `timeZone` 重建的本地墙钟秒；忽略亚秒，不把 UTC instant 直接当作 key；同 key 恰好 1 JPG/JPEG + 1 RAW（ARW 或 DNG）。为兼容已有报告，内部 `ARW` 角色名表示整个 RAW 槽位。
- B1 detail enrichment 采用离线预筛：仅对 COMPLETE/TWO_PASS_STABLE、全为 SEARCH/NOT_READ 且同 owner/stem 同时存在 JPG 与 RAW 的全部相关资产生成 request proposal；重复同侧保留，单侧和其他扩展名排除。既有 7,083 行报告的规划基线为 3,746 JPG、3,337 RAW、1,803 两侧 stem group、1,360 唯一一对 group、443 重复同侧 group，预计 4,488 个 detail GET；这不是 live 执行授权或结果。
- directory、library、camera model、serial、hash 仅可审计，绝不能参与 `CANDIDATE` 判断；跨目录和跨 library 允许配对；同 role 重复是 `AMBIGUOUS`；缺失/无效原始时间是 `UNVERIFIED`；不得使用 mtime/ctime 或 Immich 时间回退。
- A 阶段不得调用 Immich 写 API、访问 PostgreSQL、创建/解除 Stack、删除/恢复 Asset/Trash、创建正式 SQLite/pair DB，也不得进入 B/C/D 实现。
- 可以按需要拆分多代理，但每个实现代理以本组详细文档为先；文档是交付接口，代码、测试和报告字段必须与文档同步。
- 交付状态必须区分：第一轮已完成、第二轮已实现并验证、真实 dry-run 待主代理执行；未执行的事情不能写成完成。

## 2026-09-10 — 完整产品模型（阶段外约束）

- 产品目标是两个独立 Immich Asset 的 JPG/RAW（ARW 或 DNG）关系；未来使用原生 Stack，JPG primary、RAW secondary。
- 查看器默认展示 JPG，并提供明确的 ARW 切换。
- 删除必须逐侧明确选择；Stack 不提供级联删除授权。
- 未来独立 SQLite 只属于本项目，不得写 Immich PostgreSQL；A 阶段不创建它。
- B/C/D 在本轮只记录需求和进入门槛，未获授权不得实现。
