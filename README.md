# workflow-sm — 状态机驱动的 MCP 工作流引擎

一个**有状态**的工作流编排 MCP server。用工具调用驱动 agent 按确定的顺序执行流程,顺序是**硬约束**(跳步/乱序/重报都会被拒),状态**落盘持久化**,支持**断点恢复**。

**差异化**:它是唯一一个把执行顺序做成硬约束、可断点恢复、且能跑在**任意 MCP 客户端**里的轻量工作流引擎。不依赖某个特定 agent 框架(不像绑死 Claude Code 的元外壳),也不只是个无状态的配方图书馆(不像只给 YAML 不跟踪执行的方案)。详见 [DESIGN-RATIONALE.md](./docs/DESIGN-RATIONALE.md)。

---

## 它解决什么问题

你有一套流程(比如"调研 → 分析 → 起草 → 保存"或"讨论 → 规划 → 执行 → 审查"),想让 agent **严格按顺序**走,而不是它自己即兴编排、跳步、伪造结果。而且你需要:

- **可恢复** —— 流程跑到一半中断(关机、context 满、crash),能从断点接着跑,不用从头来
- **可约束** —— 顺序由 server 强制,agent 没法绕过(详见 [混沌测试](#测试))
- **可并行** —— 把独立的步骤标记成同组,同时激活,任意顺序完成
- **可重试** —— 给易失败的步骤设上限,失败自动重试,耗尽才放弃
- **可分支** —— agent 可以在 report 时自主决定跳到任意步(向前推进 / 向后回退 / 循环重做),无需任何声明式表达式引擎
- **不绑特定 agent** —— 标准 MCP 协议,Claude Code / Codex / Cline / 任意 MCP 客户端都能接

---

## 五个工具

| 工具 | 干什么 |
|---|---|
| `start_workflow(yaml)` | 开始一个工作流,返回 `run_id` + 第一步指令 |
| `report_step_result(run_id, step_id, output, status?, next_step_id?)` | 报告当前步结果,推进状态机(可选:报告失败触发重试 / 显式跳转到指定步) |
| `get_run_status(run_id)` | 查看某个 run 的当前进度(断点恢复时用) |
| `list_runs(only_incomplete?)` | 列出所有 run(含中断的),用于重启后找没跑完的 |
| `rewind(run_id, to_step_id)` | 把某个 run 倒带回退到指定步,从那里重新跑 |

**核心约束**:`report_step_result` 只能报告"当前活跃集"里的步骤(线性模式 = 当前步;并行模式 = 同组所有活跃步)——跳步、重报、乱序、报不存在步全部被拒。这是状态机的强制顺序保证,在 [混沌测试](#测试) 里实测覆盖。

---

## 三大能力

### 1. 并行组(`group`)
把连续的同 `group` 步骤标记为一组,server 会把它们**同时激活**为 running,你可以任意顺序 report 它们;组内全部完成后才推进到下一步。

```yaml
steps:
  - id: fetch-a
    group: collect      # ← 和 fetch-b 同组,同时开始
  - id: fetch-b
    group: collect
  - id: merge           # ← 组完成后才执行
```

### 2. 重试(`max_attempts`)
给易失败的步骤设上限。agent report `status: "failure"` 时,server 递增尝试次数,未耗尽就让该步重新 running 并提示"第 X/N 次重试";耗尽则该步 `failed`、整个 run `failed`。

```yaml
steps:
  - id: flaky-api
    max_attempts: 3     # ← 最多试 3 次(含首次)
```

### 3. agent 自主跳转(`next_step_id`)
agent 在 report 成功时,可以传 `next_step_id` 显式跳转到任意步骤——**这是条件分支、循环、回退的统一原语,完全由 agent 判断,server 不解释任何表达式**。

```
# report 时传 next_step_id 实现回退重做
report_step_result(run_id, step_id="verify", output="不满意", next_step_id="merge")
# → 跳回 merge 重跑(循环)
```

> 为什么不要表达式引擎?因为 **agent 本身就是最强的求值器**。让 agent 读 output 自己判断该跳哪,比让 server 解释 `when: output.contains("error")` 更灵活、更可靠。这是和 Temporal/Airflow 这类声明式 DAG 引擎**错位竞争**的根基。详见 [DESIGN-RATIONALE.md](./docs/DESIGN-RATIONALE.md)。

---

## 安装

### 1. 依赖
需要 Node.js ≥ 18。

```bash
git clone <repo-url> workflow-sm && cd workflow-sm
npm install
npm run build      # 编译 TypeScript → dist/
```

### 2. 注册到你的 MCP 客户端

**Claude Code**:
```bash
claude mcp add workflow-sm -s user -- node "/绝对路径/dist/server.js"
```

**其他 MCP 客户端**:在客户端的 MCP 配置里加一个 stdio server,command 为 `node`,args 为 `/绝对路径/dist/server.js`。

**Codex**(新版已有 `codex mcp add`,也可手编 `~/.codex/config.toml`):

```toml
[mcp_servers.workflow-sm]
command = "node"
args = ["C:/绝对路径/dist/server.js"]   # Windows 路径用正斜杠
```

> Codex(2026)已有与 Claude Code 同构的 skills(`~/.codex/skills/<name>/SKILL.md`,格式一致、`/skill` 调用)。工作流里绑定的 skill 在 Codex 下同样可用——把 skill 目录复制到 `~/.codex/skills/` 即可。

> ⚠️ **Codex 兼容性实测(2026-08,codex-cli 0.120.0 / 0.147.0)**:
> 1. **0.121+ 存在 MCP 工具注入回归**([issue #19649](https://github.com/openai/codex/issues/19649)):server 正常注册、拉起、握手,但工具不注入线程。**0.120.0 实测可用**(`npm i -g @openai/codex@0.120.0`)。
> 2. **exec 模式会自动取消 MCP 调用**(approval 无人批准即拒绝):加 `--dangerously-bypass-approvals-and-sandbox`;交互式 TUI 则在弹批准时确认即可。
> 3. 自定义 provider(OpenAI 兼容中转)需 `wire_api = "responses"`(0.147 起 chat 协议已移除)。
> 已实测:Codex 0.120 + 国产模型(GLM)驱动 workflow-sm 完整跑通 4 步工作流,看板实时刷新,断点落盘正常。

**Claude Desktop**(编辑 `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "workflow-sm": {
      "command": "node",
      "args": ["/绝对路径/dist/server.js"]
    }
  }
}
```

> ⚠️ GUI 客户端(Claude Desktop / Cursor)不继承 shell 的 PATH:若用 nvm,`command` 需写 node 的**绝对路径**(如 `~/.nvm/versions/node/v20/bin/node`),否则会 spawn 失败。

> 验证(Claude Code):`claude mcp list` 应显示 `workflow-sm: ... ✔ Connected`。
> 注册后**重启客户端**,工具才会被发现(MCP 在会话开始时发现工具)。

### 3. 状态文件位置

状态持久化在 `~/.workflow-runs/<run_id>.json`(每 run 一份,人眼可读的 JSON)。跨项目共享,server 重启后自动 `loadAll` 恢复全部历史 run——这就是断点恢复。

### 4. 可视化看板(实时)

server 启动时会同时开一个本地 HTTP 看板(默认 `http://127.0.0.1:7777`,端口占用自动 +1)。**在 agent 跑工作流的同时,浏览器打开这个地址就能实时看到进度**——状态一变就自动刷新,无需手动刷新。

```
┌─ Claude Code ────┐  stdio(MCP)   ┌─ workflow-sm server(单进程)─┐  ┌─ 浏览器 ─────┐
│  agent 调工具     │ ──────────────►│  ├─ MCP stdio transport      │  │ 看板 HTML/JS │
└──────────────────┘                │  ├─ HTTP server(:7777)      │◄─│ (实时 SSE)  │
                                    │  └─ WorkflowEngine(内存真相)│◄─│ (可 rewind) │
                                    └──────────────────────────────┘  └─────────────┘
```

**看板能看到**:
- 左栏:所有 run 列表(状态 emoji / 进度 / 相对时间)
- 右栏:选中 run 的步骤详情——✓/▶/✗ 标记、**并行组同色高亮**、**重试计数**、耗时、output(点击展开)
- 当前活跃的步有**脉冲动画**边框,一眼看出"正在跑"

**看板能操作**:
- 🔄 刷新、📋 复制 run_id
- ⏪ rewind:选目标 step,倒带重跑(二次确认)
- 🗑️ 删除:清掉不要的/僵尸 run(内存+磁盘一起删,二次确认)

**状态语义**:侧栏分四组——● 运行中(10 分钟内有更新,带脉冲)/ ⏸️ **中断**(标记 running 但闲置超 10 分钟——没有进程在推进它,可续跑或删除)/ ✗ 失败 / ✓ 已完成。

**实时性**:基于 SSE(Server-Sent Events)。engine 每次状态变更(server 端)→ 推送给所有连着的浏览器,亚秒级延迟。

**找到端口**(server 被 Claude Code 启动时看不到 stderr):
- 看 `~/.workflow-runs/.web-port` 文件(记录最近启动实例的端口)
- 或直接试 `http://127.0.0.1:7777`(占用时会顺延到 7778...)

**多实例规则**(每个 MCP 客户端会话都会拉起自己的 server 实例):
| 实例 | 用途 |
|------|------|
| 会话实例(.web-port 指向的端口) | agent 正在跑的 run 的**实时**画面(SSE 亚秒推送) |
| 常驻查看器(`npm run viewer`) | **自动同步磁盘**的常驻看板(≤30 秒延迟),看所有实例的历史/新 run,会话间隙做 rewind/删除 |

> 查看器模式(`node dist/viewer.js`)每次读接口前重新加载磁盘状态,所以能看到其他实例新写入的 run;普通会话实例不开启此模式(保护自己的内存真相)。

> 看板是**查看 + rewind + 删除**,不能新建/编辑工作流(那是 YAML 文件的事)。它也**只显示 workflow-sm 启动的工作流**——agent 的普通任务(没调 `start_workflow`)不会出现在看板上。MCP stdio 协议完全不受影响——看板挂了也不会影响 agent 调工具。

---

## 使用

### 基本流程(在 agent 对话里)

```
请用 workflow-sm 跑 examples/sample-skill-workflow.yaml:
1. 读这个 YAML 的内容
2. 调用 start_workflow,把 YAML 内容作为 yaml 参数传入
3. 按返回的指令推进:调它说的 skill / 做它说的任务
   → 跑完调 report_step_result(run_id, step_id, output) 报告结果
   → 拿到下一步,重复直到完成
```

agent 会:
1. `start_workflow` → 拿到 run_id 和第一步指令
2. 第一步绑了 skill → 在对话里调用 `/skill-name`(交互式 skill 会问问题,正常答)
3. 跑完把产出 `report_step_result` 回去 → 推进到第二步
4. 重复直到 `🎉 工作流全部完成!`

### 断点恢复(核心特性)

```
跑到一半 → 直接关掉客户端 / 重启电脑(状态已自动落盘)
         ↓
重新打开客户端
         ↓
让 agent: list_runs(only_incomplete=true)
         → 看到 "⏸️ run_xxx | feature-dev-flow | 2/4步 | running"
         ↓
让 agent: get_run_status(run_id="run_xxx")
         → 确认该从第 3 步继续,前两步产出完整保留
         ↓
让 agent: report_step_result(run_id, step_id="第3步id", output="...")
         → 接着跑完
```

### 三个示例工作流

| 文件 | 演示 |
|---|---|
| `examples/sample-workflow.yaml` | 纯自然语言 4 步线性流程(最简单) |
| `examples/sample-skill-workflow.yaml` | 每步绑定真实 Claude Code skill(半自动) |
| `examples/sample-parallel-workflow.yaml` | **并行组 + 重试 + agent goto**(全部能力) |

---

## YAML 语法

```yaml
name: my-flow              # 必填:工作流名
description: 描述           # 可选

steps:                      # 必填:步骤数组
  - id: discuss             #   必填:步骤唯一 id
    skill: gsd-discuss-phase  # 可选:绑定的 skill(server 提示 agent 调用 /skill)
    args: "--analyze"         # 可选:传给 skill 的参数
    group: collect            # 可选:并行组名(连续同名的步同时激活)
    max_attempts: 3           # 可选:失败重试上限(默认 1 = 不重试)
    description: 收集上下文   # 可选
    instruction: 说明文字     # 可选:给 agent 的补充说明

  - id: plan                # 这步没绑 skill → 纯自然语言任务
    instruction: 基于上一步产出做规划
```

**所有新字段都是可选的**。一个不含任何新字段的 YAML,行为和纯线性流程完全一致(向后兼容)。

**两种步骤执行方式**:
- **绑了 `skill`** → server 提示 agent "调用 `/skill-name`",agent 在对话里跑(交互式 skill 会问问题)
- **没绑 skill** → server 给自然语言 `instruction`,agent 自己做

**report 时的高级参数**(全可选):
- `status: "failure"` → 触发该步的重试逻辑(受 `max_attempts` 限制)
- `next_step_id: "xxx"` → 成功后跳转到指定步(分支/循环/回退;仅 success 时生效)

---

## ⚠️ 重要说明

1. **断点恢复能恢复"状态",恢复不了"agent 的思考上下文"** —— 接手的 agent 是全新的,只能靠状态机喂给它的各步产出文本继续。线性、每步独立的流程没问题;需要 agent 跨步记住大量隐式上下文的复杂流程会打折。

2. **skill 是"半自动"的** —— server 管编排顺序,但 skill 的执行始终是 agent 在对话里调。交互式 skill 跑到一半会问你问题,这是 skill 本身的特性。

3. **状态不自动清理** —— `~/.workflow-runs/` 会累积 run 文件。手动删或写个清理脚本即可。

4. **明确不做的事**(见 [DESIGN-RATIONALE.md](./docs/DESIGN-RATIONALE.md)):声明式条件表达式引擎、自动循环语法、超时/定时器/cron、子工作流、数据库、Web UI、自动执行 skill、热加载定义。这些是刻意砍掉以守聚焦的——大多有现成替代(`next_step_id` 替代表达式,Temporal 替代定时器,等等)。

---

## 测试

```bash
npm run build
npm test                      # 一键跑全部 7 套

# 或单独跑:
node test/test-engine.mjs          # 状态机逻辑:17/17
node test/test-agent-chaos.mjs     # 混沌 agent(状态机管住乱来):7/7
node test/test-persistence.mjs     # 持久化 + 断点恢复 + skill 解析:23/23
node test/test-mcp-protocol.mjs    # MCP 协议全链路:12/12
node test/test-retry-goto.mjs      # 重试 + agent 跳转:27/27
node test/test-parallel.mjs        # 并行组:33/33
node test/test-web.mjs             # 可视化看板(HTTP+SSE+rewind):28/28
```

全部应显示 `0 failed`。合计 **147 个用例**。

---

## 项目结构

```
workflow-sm/
├── src/
│   ├── engine.ts              状态机逻辑(纯逻辑,可独立测试)
│   ├── server.ts              MCP server(5 个工具 + 持久化 + 启动看板)
│   └── web.ts                 HTTP+SSE 看板桥接层(零依赖,Node 内置 http)
├── web/
│   └── index.html             看板前端(纯原生 HTML/CSS/JS,暗色主题)
├── dist/                      编译产物(注册到 MCP 用的就是这个)
├── examples/                  三个示例工作流(YAML)
├── test/                      测试脚本
├── docs/                      设计、实验和验证文档
├── artifacts/                 演示产物、发布包与公众号素材
└── LICENSE                    MIT
```

## 如何卸载

```bash
claude mcp remove workflow-sm -s user          # 取消注册(Claude Code)
rm -rf ~/.workflow-runs                         # 删状态文件(可选)
```

## License

MIT — 见 [LICENSE](./LICENSE)。
