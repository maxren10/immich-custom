# 内置 JPG/RAW 配对执行器

这是 Immich Custom 的内置服务，随主仓库一起构建和部署，不需要另行克隆仓库。

- 入口：`Dockerfile.runner` 与 `src/task-runner-main.ts`。
- Node.js：24 或更新版本（使用 `node:sqlite`）。
- 部署：[单仓库部署指南](../../docs/standalone-deployment.md)。
- 容器运行合同回归：`npm ci && npm run test:container`；完整开发回归 `npm test` 在 Windows 上运行。
- 许可证：[AGPL-3.0](LICENSE)，与主仓库一致。
- 设计与开发历史：[DEVELOPMENT.md](DEVELOPMENT.md) 及 `docs/`；其中机器路径和历史运行数据仅记录开发过程，不是部署要求。
