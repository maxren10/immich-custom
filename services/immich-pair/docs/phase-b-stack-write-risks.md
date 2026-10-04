# Stack 批量写入已知危险点（排障索引）

本文件是后期排障索引，不是扩大测试矩阵的要求。当前实现服务于单用户、单进程 writer 和并发 1；这些措施降低本地重复调度，但不能把 Immich 3.1.0 变成原子事务。

## 1. TOCTOU（临写前读与 POST 之间）

流程会先读取 JPG/RAW 的 Asset detail，确认两侧仍是目标 owner、explicit library、verified localSecond、非 trash/offline 且 `stack=NONE`，再在 SQLite 中提交 `DISPATCH_INTENT`，最后发送一次 POST。另一个客户端仍可能在这两个动作之间修改 Stack。

Immich v3.1.0 没有可供本工具使用的“两个 Asset 仍无 Stack”CAS 前置条件。若发生竞态，POST 可能合并既有 Stack、吸收第三成员或改写原有关系；body 只有两个 ID 不代表影响范围只有两个 Asset。

排查：对照 SQLite 的 `DISPATCH_INTENT`/`ACKNOWLEDGED`/`UNCERTAIN` journal、保存的 receipt、post-read observation 和 Immich 当前 Stack members。工具不会自动 DELETE、拆 Stack 或回滚。

## 2. Immich 非幂等与未知结果

`POST /api/stacks` 没有本项目可依赖的服务端 idempotency key。进程可能在服务端提交后、客户端收到响应前退出；timeout、断流、5xx 或坏响应都不能证明“没有写入”。因此：

- intent 一旦提交，attempt 额度即消费，不退款。
- 已有 intent 或 unknown operation 只允许 read-only reconcile，禁止盲重试。
- 有合法 receipt 且独立 GET 完全匹配才能 `REGISTERED`。
- 没有 receipt 但看到等价二元 Stack 只能 `UNATTRIBUTED`，不能认领为本工具创建。
- 观察仍为 NONE 也保持 `UNCERTAIN`，因为迟到请求可能随后生效。

## 3. 普通 Stack 关系影响

Immich create repository 可能处理输入中的既有 primary Stack，并更新目标 Asset 的 `stackId`。同时，如果其他 writer 在临界窗口加入第三 Asset，写后观察会报告第三成员/primary 漂移，但无法撤销已发生的服务器关系变化。

`STACK_HAS_OTHER_ASSETS`、split/partial conflict、primary 变化和 metadata drift 均停止该 operation。后续应先人工核对 Stack 全部成员，再决定是否在 Immich UI/API 中处理；本工具不提供 Stack 删除或拆分功能。

## 4. B1 证据与范围限制

B1 manifest 是只读来源，不是服务器快照。`EXPLICIT_LIBRARIES` 只证明已选 library 集合内的当前 detail 证据；范围外同 stem Asset 不会因为没有出现在当前报告中就被判定不存在。歧义组、缺失侧、未验证时间和非当前 owner/library 都排除。

plan 的 source digest 证明输入文件没有被静默替换，不证明源数据永远不变，也不证明 API key 身份或用户批准。

## 5. SQLite 与外部服务器不是分布式事务

本地事务保证 claim、attempt、intent、receipt、outcome 和 checkpoint 的持久顺序；它不与 Immich 数据库构成两阶段提交。可能出现：服务器已写、本地只保存 intent；本地保存 receipt、进程随后退出；报告导出失败但远端结果已存在。恢复以 SQLite operation state + 只读远端观察为准，不依靠重新 POST 修复。

离线 CLI 的 mock server 状态与 SQLite 客户端状态分文件持久化，并绑定 mock instance/plan；它只用于证明跨进程恢复语义。mock state 丢失或绑定不符时必须停止，不能根据 SQLite receipt 自动重建“远端已写”事实。

## 6. 人工处理入口

以下状态需要人工确认，不要直接改 SQLite 状态或删除 journal：

- `UNCERTAIN`：先查远端 Stack，再决定是否保留/登记/人工修复。
- `UNATTRIBUTED`：有等价 Stack 但无可靠 response id，不能自动认领。
- `BLOCKED`/`DRIFTED`：核对第三成员、primary 和其他客户端操作。
- 数据库损坏、registry/deployment mismatch 或 journal 与 operation 不一致：先备份并停止 writer。

正常路径只追加 journal、更新带 revision 的当前状态；不要直接修改历史事件来“补齐”一次写入。
