# Phase A 交接记录

版本：A 阶段第二轮最终交接（2026-09-10）。实现代理未运行真实样本；主代理完成首次验收，并在 Astra 终审阻塞修复后重新运行生成最终报告，见第 8 节。本文只记录已经实际落盘和验证的事实。

## 1. 项目和边界

- 项目目录：`I:\\ai\\immich-pair`。
- 只允许修改本项目；禁止修改 `I:\\ai\\photo_manager`、`I:\\ai\\immich`、Compose/容器/数据库。
- 唯一允许真实样本根：`I:\\photos\\PHOTOMANAGER_TEST`；实现代理和自动化测试不得运行真实样本命令，主代理只在验收步骤只读运行。
- protected roots：`I:\\photos\\unmodified`、`/mnt/photos`；不得访问。
- A 阶段禁止 Immich 写 API、PostgreSQL、Stack 创建/解除、Asset/Trash 删除恢复、正式 SQLite/pair DB。

## 2. 文档先行证据（已完成）

本轮先落盘并作为实现接口的文档：

- `docs/product-requirements.md`：完整产品目标、Immich 两 Asset + Stack、独立 SQLite、JPG primary、查看切换、逐侧删除、Stack 不级联、A/B/C/D 范围和门槛。
- `.DNG` 与 `.ARW` 统一进入 RAW 逻辑槽位；为兼容既有报告与 Phase B 字段，内部角色名仍保留为 `ARW`，真实扩展名保留在 sourceId/文件名中。
- `docs/decisions.md`：2026-09-10 用户锁定的 TypeScript 项目路径、本机只读、样本/protected roots、精确匹配规则、多代理和文档优先。
- `docs/phase-a-design.md`：第二轮模块、类型/schema、算法、allowlist、报告、退出码、安全不变量、失败语义、测试契约。
- `docs/phase-a-acceptance.md`：第一轮已完成项、第二轮待验收项、禁止副作用和真实 dry-run 门槛。
- `README.md`：全部文档入口、dry-run 命令和安全警告。

本轮已在授权范围内落盘第二轮实现、critical 测试和文档回填；实现代理没有执行真实样本 dry-run，主代理的最终运行见第 8 节。

## 3. 第一轮已完成证据

第一轮已经存在并在本次实施前读过：

- 固定 Immich origin 的只读 policy/client 和写 endpoint fetch 前拒绝。
- 显式配置、脱敏、Windows lexical/protected/reparse guard 接口。
- inventory 分页、页循环、重复 ID、owner/library 边界和两遍稳定性判断。
- `executable=false`、第一轮契约、mock fetch 测试。

第一轮此前记录的命令结果：

| 命令 | 第一轮记录结果 |
| --- | --- |
| `npm install --ignore-scripts` | 退出码 0 |
| `npm run typecheck` | 退出码 0 |
| `npm run test:critical` | 11 tests pass |
| `npm test` | 13 tests pass |
| `npm run cli -- doctor` | 退出码 0，未发网络 |
| `npm run cli -- scan --dry-run` | 退出码 3，未扫描默认路径 |

这些结果是第一轮证据，不代表第二轮完成。第二轮实现代理没有运行真实样本；主代理随后完成了真实 dry-run，见第 8 节。

## 4. 第二轮已实现事实

- [x] 复用现有 `exif-reader.ts`、`local-sample.ts`、`pairing.ts`，CLI 已串起显式 ExifTool、只读样本扫描、纯函数规划和报告写入。
- [x] `exif-reader.ts` 使用 `-G1:4` 保留同一 ExifIFD 的重复实例；parser 只接受基础 `ExifIFD`/`ExifIFD:CopyN`，同值重复为 VERIFIED、同组不同值为 CONFLICT，XMP/其他 group 不参与。
- [x] `local-sample.ts` 在读取后再次安全枚举媒体路径，并复核初次文件最终 size/mtime（启用 SHA-256 时复核 digest）；新增、删除或最终变化产生 ERROR issue 并返回 `INCOMPLETE`。
- [x] 新建 `src/report-writer.ts`：报告 run 目录和 JSONL 文件独占创建，`manifest.json` 最后写入；报告包含资产、pair decision、issue、digest、文件摘要和 `canBeUsedForPhaseB=false`。
- [x] `src/config.ts`/`src/cli.ts` 支持 `LOCAL_SAMPLE_DRY_RUN`；该模式只要求显式 `ownerId`、`sampleRoot`、`reportDir`、`exiftoolPath`，不要求 `apiKey`/`libraryId`，不暴露或启用 `allowVirtualFixture`。
- [x] `tests/local-dry-run-critical.test.ts` 使用项目内临时合成 fixture 和 fake reader，覆盖跨目录/Unicode stem/跨 library 审计、精确本地秒、重复 role、缺 EXIF、不同秒、源文件不变、digest、报告独占创建和 Phase B 门禁。
- [x] `config.example.json` 和 `README.md` 已切换到本地 dry-run 的显式配置说明。

## 5. 当前复核命令与结果（2026-09-10）

以下命令已在第二轮实现收尾后重新运行；没有运行真实样本命令、真实 `scan --dry-run`、Immich 请求或数据库操作：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 退出码 0 |
| `npm run test:critical` | 退出码 0，12 tests pass，0 fail |
| `npm test` | 退出码 0，14 tests pass，0 fail |

关键流程使用项目内临时合成 fixture 和 fake reader；CLI 路径错误分类断言返回 5。`npm run build` 由两个测试脚本内部调用，只生成/更新本项目 `dist/` 构建产物。扫描 extractor 不可用或输入快照不完整时，CLI 在报告写入前返回 4/3，不创建 completed manifest。

## 6. 主代理真实 dry-run 模板（实施完成后才执行）

下面是主代理使用过的命令模板，仍要求先确认 `I:\\photos\\PHOTOMANAGER_TEST` 和报告目录，再填入显式 ExifTool 路径；不能把 `<...>` 直接当作值执行：

```json
{
  "mode": "LOCAL_SAMPLE_DRY_RUN",
  "ownerId": "<EXPLICIT_OWNER_ID>",
  "sampleRoot": "I:\\photos\\PHOTOMANAGER_TEST",
  "reportDir": "<ABSOLUTE_REPORT_DIR_OUTSIDE_SAMPLE_AND_PROTECTED_ROOTS>",
  "exiftoolPath": "I:\\software\\XnViewMP\\AddOn\\exiftool.exe"
}
```

主代理执行：

```powershell
Set-Location -LiteralPath 'I:\\ai\\immich-pair'
npm run cli -- scan --dry-run --config '<ABSOLUTE_CONFIG_JSON>'
```

执行前后必须确认：不包含 API key/headers；报告 `mode=LOCAL_SAMPLE_DRY_RUN`、`source=LOCAL_SAMPLE`、`executable=false`、`canBeUsedForPhaseB=false`；plan/evidence/pair digest 可复核；没有 SQLite、Immich 写请求或样本写入。报告目录每次使用新 run-id，不能覆盖已有 run。

## 7. B/C/D 状态

B/C/D 仅在 `product-requirements.md` 中记录需求和门槛。本次交接不授权真实 Immich 写入、Stack 管理、查看器改造、逐侧删除、Trash 或恢复实现。

## 8. 主代理真实样本 dry-run（2026-09-10）

代码与合成测试验收后，主代理使用显式命令行参数对唯一获准样本根 `I:\\photos\\PHOTOMANAGER_TEST` 运行只读 dry-run；Astra 终审发现并修复重复 EXIF 实例保留及扫描末尾集合复核后，主代理再次运行生成最终报告。实现代理没有运行这些命令。主代理未创建含凭据的配置文件，owner 标签为 `LOCAL_SAMPLE_OWNER`，报告根为 `I:\\ai\\immich-pair\\reports`。

- 退出码：0。
- 最终 run：`run-mtv0vc6k-08ae798898e1b817`。修复前 run `run-mtv0e8vs-1a6e7c6cb0231fa6` 因 exclusive-create 语义保留为历史审计记录，不作为最终验收依据。
- 资产：60；pair decisions：30；issues：0；30 个 decision 全部为 `CANDIDATE`，JPG primary，`executable=false`。
- manifest：`status=COMPLETED`、`source=LOCAL_SAMPLE`、`mode=LOCAL_SAMPLE_DRY_RUN`、`canBeUsedForPhaseB=false`。
- 源保护：运行前后媒体文件数均为 60，大小/mtime 变化 0、移除 0；60/60 条资产记录的 `sourceUnchanged=true` 且读前/读后 SHA-256 相同。
- 报告完整性：`assets.jsonl`、`pairs.jsonl`、`issues.jsonl` 的实际 SHA-256 均与 manifest 摘要一致；报告中没有 `assetId`、Authorization 或 Bearer。
- digest：`planDigest=6f7f30b7033612961c96f94461653ff3259608f437b2d45e5c057438ae287564`，`pairDigest=ceed410c8c505a5c009bcf312f30ee91beced411163279bf36f4d61d00e71cb7`，`evidenceDigest=92bd9958123e8beda01750a212e37d181810df0e4476ef414c0b2721a1f7f291`。

该报告只证明本地文件规则在这批样本上的只读候选结果；没有 Immich Asset ID，因此不能直接进入 Phase B 执行。
