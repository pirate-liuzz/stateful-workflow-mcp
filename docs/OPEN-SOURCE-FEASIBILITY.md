# 开源可行性报告 — workflow-sm

> 1 天 spike 的结论。基于对两个直接竞品的**实勘(读了仓库全文)**、WebSearch 行业信号、以及现有 52 个测试全绿的原型。

---

## 一、结论先行(Go / No-Go)

### 🟡 有条件 Go —— 但**不作为"产品"开源,先作为"参考实现 / 模式库"开源**

| 维度 | 判断 |
|------|------|
| 技术差异化是否真实? | ✅ **是**。已读竞品源码确认,cyanheads 完全没有执行层,Ruflo 非可移植/非聚焦。 |
| 市场需求是否已证实? | ⚠️ **部分**。模式在兴起(stateful 执行、state-machine 编排),但**没找到 5-10 个明确喊"我要独立工具"的用户**。 |
| 维护能力是否够? | ⚠️ 单人。若按"产品"开源,会被并行/条件/循环的需求淹没。 |

**推荐路径:把现在这 200 行核心,作为"stateful MCP workflow 的参考实现"发出去** —— 抓住模式兴起期的话语权,但不背"产品支持"的包袱。若 star/issue 证明有真实需求,**再**升级为产品。

> 为什么不直接 No:技术差异化是真的(这是 spike 要验证的头号赌注,它通过了),放着不发等于浪费已验证的领先。
> 为什么不直接 Go-as-product:没有需求证据,且"产品"会逼你加并行/条件/循环 —— 正是我们刻意砍掉、构成差异化的东西。

---

## 二、实勘结果(竞品事实,非推测)

### 竞品 A:cyanheads/workflows-mcp-server
- **它是什么**:纯 MCP server,YAML 定义工作流,Apache-2.0,v1.0.5,活跃。
- **它的 4 个工具**:
  1. `workflow_return_list` — 列出可用工作流
  2. `workflow_get_instructions` — 取单个工作流定义
  3. `workflow_create_new` — 创建永久工作流
  4. `workflow_create_temporary` — 创建临时(不列出)工作流
- **🔴 关键缺失**:没有任何 `execute` / `report_result` / 状态跟踪工具。它自己描述临时工作流为"让 agent 整理思路的 structured plan"。
- **定性**:**无状态配方图书馆**。agent 读配方 → 自己执行 → server 完全不知道跑到哪了、不强制顺序、不能断点恢复。

### 竞品 B:Ruflo(ruvnet/ruflo,~66k★)
- **它是什么**:自称 "agent meta-harness" —— Claude Code / Codex 的执行外壳。MIT。
- **体量**:100+ agents、314 MCP 工具、26 CLI 命令、35 个 Claude Code 插件、swarm、向量记忆(AgentDB/HNSW)、自学习(SONA)、federation、GOAP 规划器、Web UI。
- **工作流在其中**:只是 35 个插件之一(`ruflo-workflows`),另有 `ruflo-goals`(GOAP A* 规划器)。
- **🔴 关键属性**:架构是 `User → Claude Code/CLI → Orchestration(MCP Server + Router + **27 Hooks**) → Swarm`。**Claude-Code 原生**(hooks、daemon、`.claude/`),状态活在自家 AgentDB 生态。
- **定性**:**巨型、绑定 Claude Code 的元外壳**。不是可移植的纯 MCP 工作流服务器,工作流也不是它的焦点。

---

## 三、workflow-sm 的真差异化(对比上面两者)

```
                 cyanheads        Ruflo             workflow-sm(我们)
─────────────────────────────────────────────────────────────────────
有状态执行层        ❌ 无            ⚠️ 有但绑生态      ✅ 核心
执行顺序 guard      ❌ 无            ⚠️ agent 自由      ✅ 硬约束(拒跳步/乱序/重报)
断点恢复 resume     ❌ 无            ⚠️ 依赖其记忆      ✅ 文件持久化 + loadAll
可移植性(任意MCP客户端)  ✅ 纯MCP   ❌ 绑Claude Code   ✅ 纯MCP
聚焦度            ⚠️ 中           ❌ 314工具/35插件   ✅ 5工具/200行
绑定 skill/命令    ❌ 无            ⚠️ 绑自家agent     ✅ 可绑任意skill
```

**一句话差异化**:
> **"唯一一个把执行顺序做成硬约束、可断点恢复、且能跑在任意 MCP 客户端里的轻量工作流引擎。"**

- 打 cyanheads:它停在"配方",我们补上了"执行 + 强制顺序 + 恢复"。
- 打 Ruflo:它是绑死 Claude Code 的巨系统,我们是 200 行、任意客户端可用的聚焦工具。

---

## 四、最小开源 MVP("参考实现"形态)

发出去有人愿意 star 的最小形态,**不超出已验证的原型**:

### 必须有(全部已有,清理即可)
- `engine.ts`(纯状态机逻辑,~280 行)+ `server.ts`(~200 行)
- 5 个工具:`start_workflow` / `report_step_result` / `get_run_status` / `list_runs` / `rewind`
- YAML schema(含 `skill` / `args` 绑定)
- 文件持久化 + `loadAll()` 断点恢复
- 2 个示例工作流(`examples/sample-workflow.yaml` 纯自然语言 + `examples/sample-skill-workflow.yaml` 绑 skill)

### 必须补
- **README**(面向陌生人):一句话定位 + "唯一差异化"(stateful guard)+ 任意 MCP 客户端安装步骤 + 2 个可跑示例
- **DESIGN-RATIONALE.md**:讲清"为什么把顺序做成硬约束""为什么故意不做并行/条件/循环" —— 这是护城河,也是拒接需求时的挡箭牌
- **LICENSE**(MIT)
- 一个能 30 秒跑通的 demo GIF 或录屏

### 明确不做(守住聚焦,写进 README)
- ❌ 并行 / 条件 / 循环 / 重试(线性 + rewind 够用)
- ❌ 数据库 / Web UI / 监控仪表盘
- ❌ 插件市场 / 多 agent / federation
- ❌ 自动执行 skill(始终 agent 在对话里调,server 只编排)

---

## 五、风险(诚实列)

| 风险 | 说明 | 缓解 |
|------|------|------|
| **Ruflo 引力** | 66k★,它有 workflows+goals 插件。已在 Ruflo 生态的用户不会为"可移植"切换。 | 不争 Ruflo 用户。瞄准"不用 Ruflo、只用裸 Claude Code/Codex/Cline 的人"。 |
| **MCP 官方收编** | MCP issue #2925 显示 spec 尚未覆盖 stateful 工作流。若官方原生支持,差异化被吸收(老项目就是被这样吓退的)。 | 先发占位"参考实现";即使被收编,模式库仍有引用价值。 |
| **需求未证实** | 模式在兴起(WebSearch:Temporal+MCP、state-machine 编排被推荐),但没找到明确喊需求的用户群。 | **所以先发参考实现而非产品。** 用 star/issue 探测真实需求。 |
| **范围蠕变** | 用户必会要并行/条件/循环 —— 正是我们砍掉的东西。 | DESIGN-RATIONALE 当挡箭牌;坚持"focused"。 |
| **单人维护** | bus factor = 1。 | 参考实现形态维护负担低;产品化再考虑。 |

---

## 六、下一步(若采纳"参考实现"路径)

1. **清理现有代码**(去实验痕迹、统一命名)—— 0.5 天
2. **写 README + DESIGN-RATIONALE + LICENSE** —— 0.5 天
3. **录 30 秒 demo**(断点恢复是最震撼的卖点)—— 0.5 天
4. **建公开 repo**(建议改名:脱离 "experiment",如 `workflow-sm` 或更描述性的名字),发到 MCP 社区 / 相关 issue 讨论
5. **观察 2-4 周**:看 star 数、issue 内容。若有人报"我在生产用"或要具体功能 → 升级为产品;否则保持参考实现,零负担。

### 触发"升级为产品"的信号(写死,避免自我合理化)
- ⭐ > 100 且有 ≥ 3 个非作者的真实使用 issue,或
- 有人主动提 PR 加功能(说明真有人深入用),或
- MCP 官方在 #2925 讨论 stateful 工作流时有人引用本仓库

**未达信号前,不投入产品化(数据库/UI/并行等)。**

---

## 附:本次 spike 方法与证据等级
- cyanheads / Ruflo:✅ **实勘**(web_reader 读仓库全文,非二手)
- 行业趋势:✅ WebSearch 多源(Temporal+MCP、state-machine 编排被推荐、multica issue #5972 "without stateful execution layer, workflows degrade as context fills")
- 真差异化:✅ **代码级对比**(上表每格都有竞品工具清单支撑)
- 用户需求:**❌ 未做**(无法在此环境访谈 5-10 用户)—— 这是本报告最大的不确定性来源,也是推荐"参考实现而非产品"的主因。
