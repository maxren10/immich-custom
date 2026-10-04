# 当前版本验证记录

日期：2026-10-04。基线：Immich v3.1.0。当前版本包含 Server/Web、内置配对执行器和单仓库 Compose；不需要克隆外部 immich-pair 项目。

## 自动测试与构建

- Web 全量 Vitest：526 通过、2 跳过，0 失败。
- 服务端配对控制器、配对服务及配置仓库：51/51 通过。
- Web/Server TypeScript 检查及 Web 生产构建通过。
- 内置执行器 Windows 完整开发回归：45 通过、1 项 Linux 专用检查跳过。
- Linux 容器运行合同回归：4/4 通过，覆盖任务主流程、重启恢复且不重复 POST、文件凭据和 POSIX SQLite。早期离线 CLI 的 Windows 路径合同不属于容器运行入口；在 Linux 上运行该旧开发测试集合会触发路径合同失败，部署回归使用 test:container。
- 新初始化脚本：2/2 通过，验证不覆盖现有密码/凭据，以及多行 key 在写入前拒绝。
- Server/Web 完整 Docker 镜像和内置执行器镜像从本仓库源码构建成功。Compose 配置校验通过；固定版本的机器学习镜像可获取。
- 从 Git 待提交索引导出不含 node_modules、dist、运行数据及私有凭据的干净源码，Docker 初始化及 Compose 校验通过；Server 和执行器镜像再次构建成功，未引用仓库外的配对源码。
- 初始化回归还在 Linux Node 24 容器内通过 2/2；验证宿主机私有 secret 目录、容器可读的单文件挂载权限和数据库密码文件权限。

## 单仓库部署主流程

使用独立项目名、独立端口、全新 named volumes 和测试凭据启动，未使用现有生产实例的数据库、照片卷或配对状态。

1. Server、PostgreSQL、Valkey、机器学习服务启动，创建新管理员并生成测试 API key。
2. 使用内置执行器镜像启动 pairing profile；控制令牌和 API key 通过 secret 文件挂载。
3. 上传一组测试 JPG/ARW，元数据正确提取。
4. 通过定制任务 API 启动配对：SUCCEEDED，committed=1，Stack POST=1，RAW 为主图。
5. 重复同一个请求 ID，返回同一任务，Stack POST 仍为 1。
6. 收藏 JPG 后，收藏搜索及堆叠详情正确定位 RAW。原文件下载 SHA-256 与输入 RAW 一致；两个测试源文件的 SHA-256 均未变化。

这次真实主流程验证与现有收藏 RAW 自动测试共同覆盖服务通信、配对、原始字节下载及副本保护。浏览器目录选择和权限弹窗未在本次重做人工交互。

## 测试环境修正

已有语言文件测试在比较前统一 CRLF/LF；日期测试明确使用 en-US，避免主机默认区域影响英文断言。均不改变产品行为。

详细部署步骤见 [单仓库部署指南](standalone-deployment.md)。
