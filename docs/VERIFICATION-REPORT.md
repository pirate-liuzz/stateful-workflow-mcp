# workflow-sm — 完整验证报告

> **报告日期**: 2026-07-31
> **验证对象**: workflow-sm(MCP-native 有状态 Skill 编排 server)
> **报告性质**: 项目收官的最终验证文档。每条结论均标注【验证方法】+【实际证据】,可追溯、可复现。

---

## 一句话总结

**workflow-sm 的全部能力已验证完毕,4 层共 52 项测试 + 1 次真实环境实操,全部通过。** 项目以"验证完毕"状态收官,是一份完整、诚实、可随时重启的资产。

---

## 验证范围(4 个层次)

| 层次 | 验证什么 | 方法 | 结果 |
|---|---|---|---|
| **L1 引擎逻辑** | 状态机推进/守卫/恢复是否正确 | 单元测试 | ✅ 15/15 |
| **L2 协议合规** | MCP 协议全链路是否畅通 | 裸 JSON-RPC 直连 | ✅ 11/11 |
| **L3 约束鲁棒** | 状态机能管住乱来的 agent 吗 | 混沌测试 | ✅ 7/7 |
| **L4 持久化+skill** | 断点恢复 + skill 编排 | 单元测试 + 端到端 + **真实实操** | ✅ 19/19 + 实操 |

**总计:52 项自动化测试 + 1 次真实 Claude Code 环境实操,零失败。**

---

## L1:引擎逻辑验证 ✅ 15/15

**【验证方法】** `test-engine.mjs` —— 不依赖 MCP,直接测纯状态机逻辑。

**【实际证据】** 覆盖的核心行为:

| 测试项 | 验证的行为 | 结果 |
|---|---|---|
| 解析 + start | YAML → 4 步,首步 running,其余 pending | ✓ |
| 正常推进 | report 当前步 → currentIndex+1,返回下一步 | ✓ |
| **跳步守卫** | report 非当前步 → **报错拒绝** | ✓ |
| 流程完成 | 最后一步 → status=completed, nextStep=null | ✓ |
| **断点恢复(rewind)** | 倒带到指定步 → 状态正确重置,流程恢复 running | ✓ |

```
结果: 15 passed, 0 failed
```

**关键结论**:状态机的核心机制(推进、强制顺序、恢复)逻辑正确。

---

## L2:MCP 协议合规验证 ✅ 11/11

**【验证方法】** `test-mcp-protocol.mjs` —— 用**裸 JSON-RPC 直连** server 进程,模拟任意 MCP 客户端(不依赖特定客户端)。这同时验证了**可移植性赌注**。

**【实际证据】** 全链路验证:

| 协议环节 | 验证内容 | 结果 |
|---|---|---|
| `initialize` | 握手成功,serverInfo 正确 | ✓ |
| `tools/list` | 暴露 **4 个工具**(start/report/status/list_runs) | ✓ |
| `tools/call: start` | 返回 run_id + 首步指令 | ✓ |
| `tools/call: report` | 推进到下一步,返回新指令 | ✓ |
| `tools/call: report(错误)` | 重复报已完成步 → **isError=true** | ✓ |
| `tools/call: status` | 返回完整进度 | ✓ |

```
结果: 11 passed, 0 failed
```

**关键结论**:
- server 符合 MCP 标准,任何 MCP 客户端(Claude Code / Codex / Cursor)走同一协议都能接 → **可移植性成立**。
- 已在真实 Claude Code 注册并连接(`claude mcp list` 显示 `workflow-sm ✔ Connected`)。

---

## L3:约束鲁棒性验证 ✅ 7/7

**【验证方法】** `test-agent-chaos.mjs` —— 模拟一个"捣乱 agent",尝试各种违规操作,看状态机能否拦截。

**【实际证据】** 4 种作恶 + 2 种合规 + 1 项轨迹记录:

| 混沌场景 | agent 的违规行为 | 状态机反应 | 结果 |
|---|---|---|---|
| 1. 跳步 | 报告未来步(跳过当前步) | ❌ 拒绝 | ✓ |
| 2. 编造 | 报告不存在的 step_id | ❌ 拒绝 | ✓ |
| 3. 重复报 | 报告已完成的步 | ❌ 拒绝 | ✓ |
| 4. 乱序 | a 之后直接报 c(跳过 b) | ❌ 拒绝 | ✓ |
| 5. 合规推进 | 乖乖 b → c | ✅ 放行,完成流程 | ✓ |
| 6. 状态查询 | get_run_status | ✅ 返回完整轨迹 | ✓ |

```
结果: 7 passed, 0 failed
```

**关键结论**:**状态机的约束力不依赖 agent 自觉,是 server 端强制的。** 这是路线 B 相对方式 A(菜谱)的根本性差异——"请你按顺序做"升级为"你只能按顺序做"。即便 agent 想乱来,也只能乖乖按序。

---

## L4:持久化 + Skill 编排验证 ✅ 19/19 + 真实实操

这是 demo 的核心能力,分两部分验证。

### L4-A:持久化 + 断点恢复 ✅ 19/19

**【验证方法】** `test-persistence.mjs` —— 模拟 `start → 丢弃引擎(模拟崩溃)→ 新引擎 loadAll → 状态完整恢复`。

**【实际证据】**:

| 验证点 | 结果 |
|---|---|
| skill 字段解析(含 args) | ✓ |
| nextStep 返回带 skill/instruction | ✓ |
| 每次 report 后状态落盘到 JSON 文件 | ✓ |
| **崩溃后新引擎 loadAll 恢复** | ✓ |
| **恢复后中断点正确**(中断步=running,其余按实际) | ✓ |
| **恢复后各步 output 完整保留**(上下文没丢) | ✓ |
| 恢复后能接着推进到完成 | ✓ |
| listRuns 返回历史记录 | ✓ |

```
结果: 19 passed, 0 failed
```

### L4-B:真实环境实操(P4 断点恢复)✅ 6/6 命中

**【验证方法】** **用户在真实 Claude Code 窗口亲手操作**(非模拟):start → 跑完第1步 → **关掉窗口** → 新窗口 → 恢复 → 跑完。

**【实际证据】**(用户实操输出,已交叉核验):

| 检查点 | 预期 | 实际 | 判定 |
|---|---|---|---|
| 关窗后新窗口 `list_runs` 能看到中断 run | `⏸️ run + 1/4步` | `run_rkv8kjvf ⏸️ feature-dev-flow 1/4步` | ✅ 命中 |
| 状态跨进程保留 | 新进程可见 | 新窗口看到 → loadAll 生效 | ✅ 命中 |
| `get_run_status` 中断点正确 | discuss✓/plan▶/其余待 | 完全一致,含 skill 调用记录 | ✅ 命中 |
| 接着 `report` 不报错 | 守卫放行 | plan→execute→review 全程无报错 | ✅ 命中 |
| 上下文产出保留 | 断点后可读历史 | agent 读到各步 artifact 并串用 | ✅ 命中 |
| 最终跑完 | `🎉 4/4 completed` | status=completed, progress=4/4 | ✅ 命中 |

**关键结论**:断点恢复**在真实 Claude Code 环境验证通过**,补上了 EXPERIMENT-REPORT 中"P4 待用户实操确认"的最后一个缺口。状态文件位于 `~/.workflow-runs/`,跨进程、跨会话持久。

---

## 交付物清单

### 代码(480 行 TypeScript)

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/engine.ts` | ~280 | 纯状态机逻辑(可独立测试,无 MCP 依赖) |
| `src/server.ts` | ~200 | MCP server:4 个工具 + 持久化 + skill 指令渲染 |

### 4 个 MCP 工具

| 工具 | 功能 |
|---|---|
| `start_workflow(yaml)` | 开始工作流,返回 run_id + 首步指令 |
| `report_step_result(run_id, step_id, output)` | 报告当前步结果,推进(含顺序守卫) |
| `get_run_status(run_id)` | 查看进度(断点恢复定位用) |
| `list_runs(only_incomplete?)` | 列出所有/中断的 run |

### 文档

| 文档 | 读者 | 内容 |
|---|---|---|
| `README.md` | 使用者 | 安装、使用、断点恢复、YAML 语法、限制 |
| `EXPERIMENT-REPORT.md` | 决策者 | 为什么做、三个赌注结论、Go/No-Go、重启条件 |
| `VERIFICATION-REPORT.md` | 本文档 | 完整验证证据 |
| `EXPERIMENT-GUIDE.md` | 历史记录 | A vs B 对照实验指南 |

### 测试(52 项全绿)

```
test-engine.mjs          15/15  状态机逻辑
test-mcp-protocol.mjs    11/11  MCP 协议全链路
test-agent-chaos.mjs      7/7   混沌 agent(约束鲁棒)
test-persistence.mjs     19/19  持久化 + 断点恢复 + skill
```

### 真实运行产物

```
demo-artifacts/          用户真实跑通的 4 步 skill 产出
  ├── discuss-CONTEXT.md
  ├── plan-PLAN.md
  ├── execute-LOG.md
  └── review-REVIEW.md

~/.workflow-runs/        3 个真实跑通的 feature-dev-flow run(状态干净,已清理垃圾)
```

---

## 三个赌注的最终结论(复盘)

源自 EXPERIMENT-REPORT,现以全部实测为据:

### 赌注 1:菜谱(方式 A)够不够用?→ **不够(在可恢复/可审查维度)**

A 和 B 在"完成质量"上**打平**(A 一样能产出好结果,且更快)。但 B 在**断点恢复、执行可审查、过程可 diff、确定性**上有结构性优势——这些 A 在原理上无法提供。**结论:个人"把事做完"A 够用;需要可恢复/可审计流程时 B 是刚需。**

### 赌注 2:MCP 工具驱动状态机顺不顺?→ **顺,三层全验证**

- 协议层(L2):11/11,裸 JSON-RPC 全链路畅通
- 约束层(L3):7/7,状态机能死死管住乱来的 agent
- 行为层(真实实操):agent 配合度完美,无卡顿无报错

### 赌注 3:可移植性 / context?→ **成立**

- server 用标准 MCP 协议,不绑特定客户端(L2 证明)
- 状态存 server 端文件,不进 agent context
- 已在真实 Claude Code 连接验证

---

## 已知限制(诚实标注,不隐藏)

| 限制 | 说明 | 影响 |
|---|---|---|
| **只支持线性流程** | 无并行/条件/循环/重试 | demo 级,非完整编排引擎 |
| **断点恢复 ≠ 恢复 agent 思考上下文** | 接手 agent 是全新的,只靠状态机喂的产出文本继续 | 线性独立步无影响;需跨步记忆的复杂流程会打折 |
| **skill 是半自动的** | server 管顺序,skill 执行靠 agent 在对话里调;交互式 skill 会问问题 | gsd-* 这类交互 skill 跑到一半会停 |
| **状态不自动清理** | run 文件累积 | 已手动清理(12→3);长期用需配清理机制 |

---

## 最终状态

✅ **项目状态:验证完毕,收官。** 

不是半途而废——所有承诺验证的能力(skill 编排、断点恢复、约束鲁棒、可移植性)均有实测证据,无一靠假设。这是一份**完整、诚实、可随时重启**的资产:

- **自用**:重启 Claude Code,按 README 用 `examples/sample-skill-workflow.yaml` 即可
- **重启产品化**:触发条件见 EXPERIMENT-REPORT 顶部(团队标准化场景 / MCP 有状态规范落地 / 真实需求转变)

---

## 附录:验证可复现命令

```bash
cd C:\Users\issuser\Documents\workflow-mcp-experiment
npm run build
node test/test-engine.mjs          # 应: 15 passed, 0 failed
node test/test-mcp-protocol.mjs    # 应: 11 passed, 0 failed
node test/test-agent-chaos.mjs     # 应: 7 passed, 0 failed
node test/test-persistence.mjs     # 应: 19 passed, 0 failed
claude mcp list               # 应显示: workflow-sm ✔ Connected
```

任何人可在本机复现全部验证。本报告所有结论均以上述命令的实际输出为据。
