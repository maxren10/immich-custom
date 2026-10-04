# Phase B：当前已确定的批量实现边界

版本：2026-09-12
状态：本节点需求已确定；代码已完成离线 mock 验证

用户已经为本节点固定以下选择，实施时不再把它们当成待选项：

| 项目 | 当前决定 |
| --- | --- |
| 运行模型 | `LOCAL_SINGLE_USER_SINGLE_WRITER`，纯本地、单进程 writer，不按多租户/恶意并发扩张 |
| 批量范围 | 实现完整 `preview/plan/apply/resume/status`，不走 canary-only 绕路 |
| 并发 | 固定 `1` |
| B1 来源 | 已完成 B1 live-detail 证据和当前 explicit library；B1 manifest 只读，不篡改 |
| evidence | `IMMICH_ASSET_DETAIL`；不读取真实原图、`I:\photos\unmodified` 或 `/mnt/photos` |
| uniqueness | 同一 owner + 当前 explicit library scope；唯一完整 JPG + ARW/DNG；歧义组排除 |
| SQLite | Node 24 `node:sqlite`，无新增 npm 依赖；默认 `I:\ai\immich-pair\data\pairs.sqlite` |
| write wire | 仅 `POST /api/stacks`，body 仅 `{assetIds:[jpgId, rawId]}`，JPG 第一项 |
| 每对顺序 | fresh 只读核对 → 最多一次 POST → 独立只读核对 |
| 恢复 | intent/attempt/receipt/outcome/checkpoint/journal 持久化；intent 或未知结果绝不盲重发 |
| transport | 本节点只启用离线 mock；禁止 live API、真实 POST、原图修改、Asset/Stack 删除、Docker/Postgres/DPAPI/key |
| 测试 | 1–3 条目标导向 smoke/critical；保留并运行既有测试 |

## 当前实现门

- `preview` 只读 B1 run 并打印候选/排除摘要。
- `plan` 生成独立 `B2_B3_STACK_BATCH_PLAN_V1`，exclusive create，保存 source 文件指纹和 plan digest。
- `apply` 要求显式 `--transport mock --confirm LOCAL_MOCK_BATCH_APPLY`，使用 SQLite 注册表和内存 mock；不触网。
- `resume` 对 `PREPARED` 继续经过 fresh read 和新 intent，对 `DISPATCH_INTENT`、`ACKNOWLEDGED`、`UNCERTAIN` 只读 reconcile。
- `status` 只读 SQLite，不在数据库不存在时创建替代库。
- 短别名 `phase-b preview|plan|apply|resume|status` 与 `phase-b batch ...` 等价。

当前 B1 live-detail 产物的只读 preview 重算结果为 1,359 个唯一 candidate pair、443 个 ambiguous group、0 个当前 Stack blocker。这个结果是 plan 输入证据，不是已执行写入数。

## 以后真实写入仍需另行确认

本节点不执行真实写入。未来若要开放 live apply，必须在新的用户确认中同时明确：

1. 具体 source run、plan digest、owner、explicit library scope 和预计 pair 数。
2. 运行时 API key 的安全提供方式；不得放入 argv、JSON、`.env`、SQLite、日志或报告。
3. 显式 live transport 参数和一次性 confirmation token；配置与命令参数必须共同满足。
4. 接受 Immich v3.1.0 无 CAS/服务端幂等，TOCTOU 可能合并或改变普通 Stack 成员；工具不自动回滚。
5. 执行窗口、暂停其他 Stack writer 的人工安排，以及未知结果/漂移后的人工处理。

这不是本节点的隐式授权，也不能因 mock 测试通过而推导出真实 POST 已安全或已执行。
