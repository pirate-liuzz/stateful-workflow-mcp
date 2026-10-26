# 项目决策记录

> 本文件是私有的项目决策记录,不随 npm 包分发(files 字段未包含它)。

## 2026-08-18 决策 1:不发布

**状态:铁律(用户原话:"我不要发布,你记死了")**

- ❌ 不发 npm registry(`npm publish` 永不执行)
- ❌ 不提交 Claude Code 官方 marketplace / MCP Registry
- ❌ 不做任何对外公开推广

**给别人用的方式只限私下共享**(见下),详见 README 各客户端配置章节。

## 分发方式备忘(全部不经过 registry)

| 方式 | 适用 | 对方操作 |
|------|------|---------|
| tgz 文件直发 | 个别人 | `npm install -g ./artifacts/releases/stateful-workflow-mcp-0.1.0.tgz` → MCP 配 `stateful-workflow-mcp` |
| 文件夹/压缩包拷贝 | 个别人 | `node dist/server.js`(需自带 Node ≥18) |
| 私有 Git 仓库 | 固定团队 | clone → `npm install`(prepare 自动构建)→ MCP 指绝对路径 |
| 公开 Git 仓库不上 npm | 若将来想放开 | `npx github:<user>/<repo>`(prepare 已就绪) |

注:若"公开 Git"也算不可接受,则仅用前三种。
