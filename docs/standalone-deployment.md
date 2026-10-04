# 单仓库部署 Immich Custom

本仓库包含定制 Immich Server/Web、JPG/RAW 配对执行器及完整 Docker Compose 配置。不需要克隆 `maxren10/immich-pair`，也不需要访问私有仓库。运行时仍需要 Docker、Compose 和用于拉取基础镜像及依赖的网络。

当前基线是 Immich v3.1.0。此流程用于新部署；迁移已有数据库、图库和任务状态需要另行制定迁移步骤。

## 1. 获取源码并初始化

```sh
git clone https://github.com/maxren10/immich-custom.git
cd immich-custom
node scripts/setup.mjs
```

初始化脚本需要 Node.js 24。只有 Docker 而没有本地 Node.js 时，在仓库根目录执行下面这条命令，PowerShell 和常见 Linux shell 均可使用：

```sh
docker run --rm -v "${PWD}:/workspace" -w /workspace node:24-bookworm-slim node scripts/setup.mjs
```

脚本新建 `.env` 和 `.secrets/control-token`，生成随机数据库密码和内部控制令牌，不输出秘密值。重复执行会保留已有文件，不重置密码或令牌。

Linux 上 `.secrets` 目录权限为 `0700`，只有目录所有者能访问；其中 secret 文件使用 `0644`，以便 Docker Compose 将单个文件只读挂载后，容器中的非 root 执行器能够读取。`.env` 使用 `0600`。通过 root Docker 容器初始化时，新文件归属会调整为仓库目录的宿主机所有者，方便后续编辑。

默认使用 Docker named volumes 保存上传照片、数据库、模型缓存和配对状态。服务监听 `127.0.0.1:2283`；如需局域网访问，在 `.env` 中调整 `IMMICH_BIND_ADDRESS`，也可修改端口和时区。

## 2. 构建并启动照片管理服务

```sh
docker compose up -d --build
docker compose ps
```

首次从源码构建会下载依赖及基础镜像，所需时间和磁盘空间随环境变化。打开 `http://localhost:2283` 创建管理员账号。照片管理和收藏 RAW 同步此时即可使用；收藏 RAW 同步需要桌面 Chrome/Edge 的文件夹写入权限。

## 3. 启用内置配对执行器

登录管理员账号，在账户设置中创建用于配对的 API key，授予 `all` 权限。执行器需要读取当前用户的资产、相册/图库和堆叠，并创建堆叠；UI 的任务入口仍要求管理员身份。API key 只能访问其所属用户可访问的内容。

将 key 写入 `.secrets/api-key`，内容为一行 key，勿加引号。该目录已被 Git 和 Docker Server 构建上下文排除。可以用编辑器保存，或使用下列不把 key 放入命令参数的方式。

PowerShell（已安装 Node.js）：

```powershell
$pairCredential = Read-Host 'Immich API key' -AsSecureString
$pairPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pairCredential)
try {
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pairPointer) | node scripts/setup.mjs --api-key-stdin
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pairPointer)
}
```

Bash（已安装 Node.js）：

```bash
read -r -s -p 'Immich API key: ' pair_api_key
printf '\n'
printf '%s\n' "$pair_api_key" | node scripts/setup.mjs --api-key-stdin
unset pair_api_key
```

保存 key 后执行：

```sh
docker compose --profile pairing up -d --build
docker compose --profile pairing ps
```

`pairing` profile 仅用于解决首次启动尚无管理员 API key 的顺序问题；执行器源码已经内置，不需要另一个项目。随后在管理任务页面启动 JPG/RAW 配对，或查看和恢复已有任务。

执行器只在与 Server 共享的网络空间内监听 loopback 端口 2284，不向宿主机发布该端口。内部 control token 与 Immich API key 分别通过 secret 文件挂载；配对数据库和任务状态保存在 `pair-state` volume。

## 可选：挂载已有 JPG/RAW 图库

如果照片已经在宿主机上，在 `.env` 中设置 `EXTERNAL_LIBRARY_PATH` 为你自己的照片目录，例如 Windows 的 `D:/Photos` 或 Linux 的 `/srv/photos`，然后使用只读挂载示例：

```sh
docker compose -f compose.yaml -f compose.external-library.example.yaml --profile pairing up -d --build
```

在 Immich 管理界面创建外部图库并把导入路径设为 `/mnt/photos`，完成扫描后即可配对。后续更新也需使用同样的两个 `-f` 参数。挂载为只读，配对通过 Immich API 修改堆叠记录，不重命名或修改原照片文件。

## 更新与持久化

更新同一基线的定制代码后，连同共享网络空间的执行器一起重建/重新创建：

```sh
git pull
docker compose --profile pairing up -d --build --force-recreate immich-server immich-pair-runner
```

如有正在运行的配对任务，先等任务结束。重新创建容器会保留 named volumes。普通停止使用 `docker compose --profile pairing down`，不要添加 `-v`，因为该参数会删除部署数据卷。

如需备份，应同时保存照片数据、Immich 数据库备份、配对状态和本地 `.env`/secret 文件；不要将秘密文件提交到 Git。

## 验证命令

```sh
node --test scripts/setup.test.mjs
docker compose --profile pairing config --quiet
docker compose --profile pairing ps
docker compose logs --tail 50 immich-server immich-pair-runner
```

配对执行器回归可在内置服务目录运行：

```sh
cd services/immich-pair
npm ci
npm run test:container
```

`test:container` 覆盖容器使用的 all-libraries 任务流程、重启恢复、文件凭据和 POSIX SQLite 路径。完整开发回归 `npm test` 在 Windows 上运行；其中早期离线 CLI 的报告路径合同为 Windows 绝对路径，不作为 Linux 容器运行入口。

新增初始化回归验证两个具体 invariant：重复初始化不会覆盖已有数据库密码和凭据；多行 API key 在写入配置前拒绝。原有 Web/Server/执行器测试无法覆盖新加入的初始化脚本，因此只增加这两个最小测试。
