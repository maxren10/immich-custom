# Phase A 设计契约：本地样本 JPG/RAW（ARW 或 DNG）只读 dry-run

版本：A 阶段第二轮设计基线（2026-09-10）

本文件是实现和审查接口。下一位代理只读本文件、`product-requirements.md`、`decisions.md` 和 `phase-a-acceptance.md` 即可继续。与第一轮实现不一致的地方，以用户锁定决策、本文件和安全边界为准。B/C/D 只记录需求，不在本阶段实现。

## 1. 已完成与本轮目标

第一轮已经完成：独立 TypeScript CLI、固定 Immich origin 的只读 allowlist、显式配置解析与脱敏、第一轮 inventory 两遍稳定性 contract、路径 lexical/protected/reparse guard 接口、mock fetch 测试和 `executable=false` 基线。

第二轮完成目标：

1. `exif-reader.ts`：显式 ExifTool、参数数组、`shell=false`、只读 JSON/组名字段，严格解析 ExifIFD `DateTimeOriginal`。
2. `local-sample.ts`：显式样本根安全检查、只读递归枚举、稳定排序、读前/后 source snapshot 和可选 SHA-256 证据。
3. `pairing.ts`：纯函数锁定规则规划、冲突/未验证语义和稳定 digest。
4. `report-writer.ts`：报告目录安全检查、全新 run-id 独占创建、JSONL 与最后 manifest。
5. `config.ts`/`contracts.ts`/`cli.ts`：本地 dry-run 配置和退出码；不需要 Immich 网络。
6. 合成 critical test：从原始时间证据经过 planner 到报告，覆盖规则、稳定性和无 SQLite 副作用。

## 2. 不可变产品规则

Pair key 只有：

```text
(owner, Unicode-NFC(lowercase(stem)), ExifIFD.DateTimeOriginal local YYYY-MM-DD HH:mm:ss)
```

其中 stem 是 basename 去掉最后一个扩展名；目录、library、camera model、serial、hash 不进入 key。原始时间必须来自文件自身的 ExifIFD `DateTimeOriginal`；亚秒和 offset 只记录，不参与 key，且不转 UTC。每个 key 只能接受恰好一个 JPG/JPEG 和一个 RAW（ARW 或 DNG）。JPG 是 proposed primary。为保持既有 schema 兼容，类型和字段中的 `ARW` 表示 RAW 逻辑槽位。所有 A 阶段结果 `executable=false`。

## 3. 模块职责和不可变接口

### 3.1 `contracts.ts`

保留第一轮公开类型，并新增/扩展以下类型；字段名是报告和测试的稳定接口：

```ts
type PairRole = "JPG" | "ARW";
type PairStatus = "CANDIDATE" | "AMBIGUOUS" | "REJECTED" | "UNVERIFIED";
type ExifTimeStatus = "VERIFIED" | "MISSING" | "INVALID" | "CONFLICT" | "UNAVAILABLE";

interface ExifTimeEvidence {
  status: ExifTimeStatus;
  source: "ExifIFD:DateTimeOriginal" | "unavailable";
  localSecond?: string;       // YYYY-MM-DD HH:mm:ss; never a Date/UTC value
  rawValue?: string | null;
  subsec?: string | null;
  offset?: string | null;
  toolPath: string;
  toolVersion?: string;
  errorCode?: string;
  errorMessage?: string;       // sanitized, no headers/secrets
}

interface LocalSampleAsset {
  source: "LOCAL_SAMPLE";
  sourceId: string;            // stable relative path, never an Immich Asset ID
  ownerId: string;
  fileName: string;
  relativePath: string;
  absolutePath: string;
  role: PairRole;
  normalizedStem: string;
  sizeBefore: number;
  mtimeMsBefore: number;
  sizeAfter: number;
  mtimeMsAfter: number;
  sourceUnchanged: boolean;
  sha256Before?: string;
  sha256After?: string;
  originalTime: ExifTimeEvidence;
  audit?: { directory?: string; library?: string; cameraModel?: string; serial?: string; hash?: string };
}

interface PairDecision {
  pairId: string;              // digest-derived, stable across run IDs
  source: "LOCAL_SAMPLE";
  status: PairStatus;
  executable: false;
  ownerId: string;
  normalizedStem: string;
  localSecond?: string;
  jpgSourceId?: string;
  arwSourceId?: string;
  proposedPrimary?: "JPG";
  reasonCodes: string[];
}

interface PairPlan {
  source: "LOCAL_SAMPLE";
  mode: "LOCAL_SAMPLE_DRY_RUN";
  executable: false;
  decisions: PairDecision[];
  issues: PlanIssue[];
  pairDigest: string;
  evidenceDigest: string;
  planDigest: string;
}
```

`sourceId` 是样本根内稳定相对路径，绝不能伪装成 Immich Asset ID；A 阶段报告不得包含 `assetId` 字段。第一轮 Immich `Asset`/`Inventory` 类型和只读 client 继续保留给只读兼容，不得被当作本地样本匹配证据。

### 3.2 `exif-reader.ts`

职责：只读调用显式 `exiftoolPath`，每次读取一个媒体文件，返回 `ExifTimeEvidence`。不得从 PATH 猜测默认程序。

执行要求：

- 使用 `child_process.execFile` 或 `spawn`，参数必须是数组，`shell: false`。
- `-config` 和 `NUL` 必须位于其他 ExifTool 参数之前；metadata 调用使用 JSON、组名和只读字段，例如 `-j -G1 -a -s -ExifIFD:DateTimeOriginal -ExifIFD:SubSecTimeOriginal -ExifIFD:OffsetTimeOriginal -- <file>`。
- 版本调用同样显式 `-config NUL`，只允许 `-ver`；记录版本但不把 `-ver` 输出当 metadata JSON。
- 严禁赋值参数、`-overwrite_original`、sidecar 写入、批量写入或任何输出文件参数。
- 严格只认 `ExifIFD:DateTimeOriginal`（及 ExifTool 对重复值的同组编号形式）；缺失是 `MISSING`，无法启动/非零退出/JSON 不可解析是 `UNAVAILABLE`，格式或日期分量无效是 `INVALID`，多个不相同候选值是 `CONFLICT`。
- 接受的原始格式是 `YYYY:MM:DD HH:mm:ss`，逐字段验证合法范围，不调用 `Date`，不转 UTC。输出的 `localSecond` 使用 `YYYY-MM-DD HH:mm:ss`。
- 记录 raw value、subsec、offset、tool version 和 error code；offset 不得改变 localSecond。

### 3.3 `local-sample.ts`

职责：在显式 sampleRoot 通过 allowed/protected/reparse 检查后，只读递归枚举 `.JPG`、`.JPEG`、`.ARW`、`.DNG`。

- 只处理普通文件；目录项或路径边界是 symlink、junction 或任意 reparse point 时 fail closed。
- 扩展名比较不区分大小写；`.JPG/.JPEG` 归入 `JPG`，`.ARW/.DNG` 归入兼容名称 `ARW` 的 RAW 逻辑槽位；稳定排序按 Unicode-NFC lowercase 的 relative path，再按原始 path 作为 tie-breaker。
- 每个文件在读取前和读取后记录 size、mtime；需要 source-unchanged 证据时计算 SHA-256。hash 仅用于证明源文件未在读取期间改变，绝不进入 pairing key。
- 不使用 mtime/ctime 作为日期，不写样本根，不改名、不复制、不生成 sidecar。
- `source="LOCAL_SAMPLE"`，`sourceId` 只使用相对路径；不得产生 Immich Asset ID。

### 3.4 `pairing.ts`

这是纯函数模块，不访问文件系统、网络、SQLite 或 Immich。

伪代码：

```text
for asset in stableSort(assets):
  stem = NFC(lowercase(removeFinalExtension(basename(asset.fileName))))
  groupByOwnerAndStem[(asset.ownerId, stem)].add(asset)

for (owner, stem) group:
  if any asset.originalTime.status != VERIFIED:
    emit UNVERIFIED for the affected deterministic group(s)
    emit issue for every missing/invalid/conflict/unavailable time
    continue only for other independently verified time groups

  for localSecond group in groupBy(asset.originalTime.localSecond):
    jpg = assets where role == JPG
    arw = assets where role == ARW
    if jpg.length == 1 and arw.length == 1:
      emit CANDIDATE(jpg, arw, proposedPrimary=JPG, executable=false)
    else if jpg.length > 1 or arw.length > 1:
      emit AMBIGUOUS with duplicate-role issue
    else:
      emit REJECTED with missing-counterpart/cardinality issue
```

`PairDecision` 的排序按 `(ownerId, normalizedStem, localSecond-or-empty, pairId)`；资产排序按 `sourceId`。目录、library、camera model、serial、hash 只能复制到 audit/evidence，不得加条件。`pairDigest` 对规范化 decisions 计算 SHA-256，`evidenceDigest` 对规范化资产证据计算 SHA-256，`planDigest` 对 `{source, mode, executable, decisions, issues, pairDigest, evidenceDigest}` 计算 SHA-256；不包含 runId、生成时间或耗时。

### 3.5 `report-writer.ts`

输入是 plan、资产和 issues，输出一个新的 run 目录：

```text
<reportDir>/<runId>/
  assets.jsonl
  pairs.jsonl
  issues.jsonl
  manifest.json              # 最后创建
```

- `reportDir` 必须显式配置；运行前检查与 sampleRoot、protected roots 互不包含并通过 reparse guard。
- 每次使用新的 runId 目录，目录和文件均 exclusive-create；已有目录或文件绝不能覆盖。
- 所有文本为 UTF-8 LF。manifest 是最后写入的成功/完成标记；任何中断或失败都不能写 `status=SUCCESS` 的 manifest。
- 不写 API key、Authorization header、二进制、SQLite 或 Immich 写请求信息。
- manifest 至少包含：`manifestVersion`、`runId`、`mode`、`source`、`executable`、`canBeUsedForPhaseB`、`status`、`generatedAt`、`durationMs`、`sampleRoot`（脱敏/规范化）、`planDigest`、`pairDigest`、`evidenceDigest`、资产/配对/issue 计数、`files` 摘要。文件摘要含相对路径、字节数、SHA-256；不为自身制造循环摘要。

JSONL 记录要求：`assets.jsonl` 是 LocalSampleAsset 的脱敏审计投影；`pairs.jsonl` 是 PairDecision；`issues.jsonl` 是 `{issueId, code, severity, sourceId?, pairId?, message}`。每条记录都必须可由 planDigest 复核。

## 4. 配置、路径和 API allowlist

### 4.1 本地 dry-run 配置

本地扫描必须显式提供：`sampleRoot`、`reportDir`、`exiftoolPath`，以及用于锁定 owner 的 `ownerId`。不提供 config 时绝不推断默认路径，也不扫描。`apiKey`、`libraryId` 和 Immich client 对本地 dry-run 可为空/不使用；若保留第一轮只读 inventory 配置，仍必须是显式值并脱敏输出。

路径要求：

- sampleRoot 必须位于 `I:\photos\PHOTOMANAGER_TEST` 内，且不在 protected root；拒绝 UNC/device path、NUL、ADS、`.`/`..` 绕过。
- protected roots 固定为 `I:\photos\unmodified`、`/mnt/photos`。
- reportDir/tempDir 与 sampleRoot/protected roots 两向互斥；现有路径逐段 lstat/reparse 检查，发现 symlink/junction/reparse 即拒绝。
- ExifTool 路径必须是显式配置值；允许 `I:\software\XnViewMP\AddOn\exiftool.exe`，不得 PATH fallback。

### 4.2 Immich 只读 allowlist（第一轮保留，A 本地模式默认不调用）

固定 origin `http://127.0.0.1:2283`，只允许：

- `GET /api/server/version`
- `GET /api/server/ping`
- `GET /api/users/me`
- `GET /api/assets/{canonical-uuid}`
- `GET /api/stacks/{canonical-uuid}`
- 第一轮 `POST /api/search/metadata` 严格分页读取（`withStacked=true`、`withExif=false`、`withDeleted=false`）
- 可选 `GET /api/assets/{uuid}/original?edited=false`，只有显式启用。

禁止所有其他 endpoint、redirect、Stack/Asset/Trash/Library/Job 写操作和 PostgreSQL。

## 5. 退出码和失败语义

| 码 | 语义 |
| --- | --- |
| 0 | 报告完整写入且无 issue；所有候选均已由规则解释 |
| 2 | 报告完整写入但存在可审计 issue（例如拒绝、歧义、缺时间） |
| 3 | 扫描/枚举/输入快照不完整，不能证明完整报告；不得写成功 manifest |
| 4 | 配置或 ExifTool/extractor 不可用；不使用任何替代时间来源 |
| 5 | 路径、reparse、protected root 或其他安全边界拒绝；不扫描、不写成功 manifest |
| 6 | 报告目录/独占创建/文件写入失败；不得写成功 manifest |

错误文本必须脱敏。`UNAVAILABLE` extractor 是 4；`MISSING`/`INVALID`/`CONFLICT` 是可报告的 `UNVERIFIED` issue，若整体文件读仍完整可返回 2。样本路径安全拒绝优先返回 5；报告写失败优先返回 6。

## 6. 安全不变量

1. 没有显式 config、sampleRoot、reportDir、exiftoolPath 就不会扫描。
2. 不读取 protected roots，不跟随 reparse，不写样本根。
3. ExifTool 进程始终 `shell=false`、参数数组、`-config NUL`，无任何写参数。
4. 原始时间不是 VERIFIED 时，不会成为 CANDIDATE；mtime/ctime/Immich 时间永不替代。
5. directory/library/model/serial/hash 永不改变 CANDIDATE 判断。
6. A 阶段所有 PairDecision `executable=false`，没有 Immich Asset ID，没有 Stack/Trash/SQLite 写入能力。
7. planDigest 与 runId/生成时间/耗时无关；同一稳定输入产生相同 digest。
8. manifest 最后写入；中断/失败不能留下 `status=SUCCESS`。
9. 报告不含 API key、Authorization header 或二进制。

## 7. 测试契约

保持 1–3 条关键流程，不扩理论矩阵：

- `original-time-to-report`：合成/虚拟 fixture 覆盖同 stem 不同大小写扩展且同秒配对、亚秒/offset 不影响、跨目录/跨 library 仍配、缺时间、重复 JPG 歧义、不同秒不配、mtime 不替代、稳定 planDigest、报告 exclusive-create、没有 SQLite。
- ExifTool contract：验证真实参数数组的 `-config NUL` 顺序、JSON/组名/只读字段、`shell=false` 约束；mock 进程输出解析，不启动真实 ExifTool。
- local/report safety：只测试项目内合成或虚拟 fixture；不访问真实样本、protected roots、Immich、PostgreSQL 或 Compose。

必须保留第一轮稳定测试，并运行：

```powershell
npm run typecheck
npm run test:critical
npm test
```

本轮不得运行真实样本命令；真实 dry-run 由主代理按交接模板执行。
