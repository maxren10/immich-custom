# Phase A 验收清单

版本：A 阶段第二轮（2026-09-10）。源码测试只认 `I:\\ai\\immich-pair` 内可复现的命令和合成/虚拟 fixture 证据；真实样本 dry-run 由主代理单独执行并在第四节记录。

## 一、第一轮基线（已完成，继续保留）

- [x] `package.json`、`package-lock.json`、`tsconfig.json` 存在，scripts 提供 typecheck/test/test:critical/cli。
- [x] `contracts.ts` 固化 `executable=false`、PairPolicy 和 inventory 状态契约。
- [x] `config.ts` 只接受显式配置，固定 origin，配置输出脱敏。
- [x] `readonly-policy.ts` 在网络调用前拒绝未知 endpoint、写 API、越界路径和 redirect 风险。
- [x] `immich-read-client.ts` 只经 policy，有限重试，401/403 不重试，错误不泄露 secret/header。
- [x] `inventory.ts` 完整跟随 `nextPage`，检测循环、重复 ID、schema/owner/library 错误，两遍变化输出不稳定。
- [x] 第一轮测试使用 mock fetch/内存响应，不连真实 Immich、PostgreSQL 或照片目录。

## 二、第二轮交付门槛

### 文档接口

- [x] `docs/product-requirements.md` 记录完整产品目标、两 Asset + Stack、独立 SQLite、JPG primary、查看切换、明确角色删除、Stack 不级联和 A/B/C/D 门槛；未授权 B/C/D 仅记录需求。
- [x] `docs/decisions.md` 记录用户锁定路径、样本根、protected roots、匹配规则、多代理和文档优先。
- [x] `docs/phase-a-design.md` 有完整模块职责、类型/schema、伪代码、路径/API allowlist、报告字段、退出码、安全不变量、失败语义和测试契约。
- [x] 代码收尾后本清单与实际实现状态、命令结果完全同步。

### 源码与安全边界

- [x] `src/exif-reader.ts` 显式 ExifTool、参数数组、`shell=false`、`-config NUL`、`-G1:4`、JSON/组名/只读字段；无写参数；严格产出 VERIFIED/MISSING/INVALID/CONFLICT/UNAVAILABLE，并隔离 XMP/其他 group。
- [x] `src/local-sample.ts` 只允许显式样本根，递归只读枚举 JPG/JPEG/ARW/DNG；ARW 与 DNG 进入同一 RAW 逻辑槽位。扫描稳定排序，拒绝 reparse，记录读前/后 snapshot 和可选 SHA-256；读后重枚举路径并复核最终 size/mtime/hash。
- [x] `src/pairing.ts` 是纯函数，只按锁定规则规划，目录/library/model/serial/hash 不参与判断，JPG proposed primary，所有结果 `executable=false`，digest 稳定。
- [x] `src/report-writer.ts` 检查 reportDir 与样本/protected roots 不重叠并通过 reparse guard；run/file exclusive-create，UTF-8 LF，manifest 最后，失败不写成功 manifest。
- [x] `config.ts`/`cli.ts` 支持 `LOCAL_SAMPLE_DRY_RUN`；scan 必须显式 sampleRoot/reportDir/exiftoolPath，未配置不扫描；本地模式不需要 Immich 网络，生产配置/CLI 不接受 `allowVirtualFixture`。
- [x] 未创建正式 SQLite/pair DB；未调用 Immich 写 API、PostgreSQL、Compose、Asset/Trash 删除恢复或 Stack 写入。

### 测试和命令

- [x] 增加第三条 critical original-time-to-report，使用项目内合成/虚拟 fixture，不复制真实照片（`tests/local-dry-run-critical.test.ts`）。
- [x] 覆盖：大小写扩展+同秒、亚秒/offset、ExifIFD 重复实例冲突/同值/XMP 隔离、跨目录/library、缺时间、重复 JPG、不同秒、mtime 不替代、读取期间新增同键 JPG、稳定 planDigest、报告 exclusive create、无 SQLite。
- [x] 至少有 ExifTool 参数构造/解析 mock 测试。
- [x] `npm run typecheck` 退出码 0。
- [x] `npm run test:critical` 退出码 0，12 tests pass，0 fail。
- [x] `npm test` 退出码 0，14 tests pass，0 fail。
- [x] 实现代理与自动化测试没有运行真实样本命令；真实样本只由主代理运行：首次验收一次，并在终审修复后再运行一次生成最终报告。

## 三、禁止副作用证据

- [x] 没有修改 `I:\\ai\\photo_manager`、`I:\\ai\\immich`、Compose、容器、数据库或全局配置。
- [x] 没有访问 `I:\\photos\\unmodified` 或 `/mnt/photos`；主代理只读访问了唯一获准的真实样本根 `I:\\photos\\PHOTOMANAGER_TEST`。
- [x] 测试未发起真实网络请求；未创建 SQLite；未输出 API key/Authorization header；报告无二进制。
- [x] `dist/`、`node_modules/` 如由本地测试生成，只视为构建产物，不是交付契约。

## 四、延期与真实 dry-run 门槛

- [x] 真实样本 dry-run：终审修复后，主代理使用显式 CLI 参数重新运行，退出码 0；60 个资产形成 30 个 `CANDIDATE`、0 issue。最终报告 run 为 `run-mtv0vc6k-08ae798898e1b817`；此前的 `run-mtv0e8vs-1a6e7c6cb0231fa6` 保留为修复前不可覆盖的审计记录，不作为最终验收报告。
- [x] 真实样本源保护：运行前后媒体文件数均为 60，大小/mtime 变化 0、移除 0；报告中 60/60 个资产均有 `sourceUnchanged=true` 且 `sha256Before=sha256After`。
- [x] 报告复核：三个明细文件 SHA-256 均与 manifest 摘要一致，无 `assetId`、Authorization/Bearer，所有 decision 均为 `CANDIDATE`、`executable=false`、JPG primary；manifest 固定 `canBeUsedForPhaseB=false`。
- [ ] B：真实 Immich 只读兼容、注册表恢复、Stack 幂等，未授权不实现。
- [ ] C：查看器/Stack UX，未授权不实现。
- [ ] D：逐侧删除、Trash、恢复和永久删除，未授权不实现。
