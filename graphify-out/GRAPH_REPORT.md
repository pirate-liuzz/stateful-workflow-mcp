# Graph Report - workflow-mcp-experiment  (2026-08-31)

## Corpus Check
- Corpus is ~14,932 words - fits in a single context window. You may not need a graph.

## Summary
- 259 nodes · 289 edges · 17 communities
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 21 edges (avg confidence: 0.89)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- 实验结论与产品化
- 项目包与依赖
- 重试跳转测试
- 工作流引擎核心
- 并行执行测试
- MCP 工作流能力
- TypeScript 配置
- 协议数据模型
- 持久化恢复测试
- Web 与 SSE 测试
- 引擎基础测试
- 开发依赖
- 构建与运行脚本
- Agent 异常测试
- MCP 协议测试
- 仪表盘交互
- 演示产物链

## God Nodes (most connected - your core abstractions)
1. `WorkflowEngine` - 20 edges
2. `compilerOptions` - 13 edges
3. `startWebServer()` - 12 edges
4. `scripts` - 9 edges
5. `keywords` - 7 edges
6. `files` - 6 edges
7. `workflow-sm Positioning` - 6 edges
8. `workflow-sm` - 5 edges
9. `Server-side RunState` - 4 edges
10. `Hard Order Guard` - 4 edges

## Surprising Connections (you probably didn't know these)
- `Productization Triggers` --semantically_similar_to--> `Product Restart Conditions`  [INFERRED] [semantically similar]
  OPEN-SOURCE-FEASIBILITY.md → EXPERIMENT-REPORT.md
- `cyanheads workflows-mcp-server` --conceptually_related_to--> `workflow-sm Positioning`  [EXTRACTED]
  OPEN-SOURCE-FEASIBILITY.md → DESIGN-RATIONALE.md
- `Ruflo` --conceptually_related_to--> `workflow-sm Positioning`  [EXTRACTED]
  OPEN-SOURCE-FEASIBILITY.md → DESIGN-RATIONALE.md
- `workflow-sm` --references--> `workflow-sm Positioning`  [EXTRACTED]
  README.md → DESIGN-RATIONALE.md
- `Route B State-machine Experiment` --conceptually_related_to--> `Hard Order Guard`  [INFERRED]
  EXPERIMENT-GUIDE.md → DESIGN-RATIONALE.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **workflow-sm Core Execution Contract** — design_rationale_server_side_runstate, design_rationale_hard_order_guard, design_rationale_agent_directed_control_flow, design_rationale_json_file_persistence [EXTRACTED 1.00]
- **workflow-sm Four-layer Verification** — verification_report_l1_engine_logic, verification_report_l2_mcp_protocol, verification_report_l3_agent_chaos, verification_report_l4_persistence_skill [EXTRACTED 1.00]
- **Feature Demo Artifact Chain** — demo_artifacts_discuss_context_demo_context, demo_artifacts_plan_plan_demo_plan, demo_artifacts_execute_log_demo_execution_log, demo_artifacts_review_review_demo_review [EXTRACTED 1.00]

## Communities (17 total, 0 thin omitted)

### Community 0 - "实验结论与产品化"
Cohesion: 0.07
Nodes (31): Embedded HTTP and SSE Dashboard, Hard Order Guard, JSON File Persistence, Server-side RunState, workflow-sm Positioning, A/B Workflow Comparison Dimensions, Route A Recipe Control, Route B State-machine Experiment (+23 more)

### Community 1 - "项目包与依赖"
Cohesion: 0.07
Nodes (27): js-yaml, @modelcontextprotocol/sdk, bin, stateful-workflow-mcp, dependencies, js-yaml, @modelcontextprotocol/sdk, description (+19 more)

### Community 2 - "重试跳转测试"
Cohesion: 0.08
Nodes (24): def, e1, e2, e3, e4, e5, e6, e7 (+16 more)

### Community 3 - "工作流引擎核心"
Cohesion: 0.17
Nodes (5): WorkflowEngine, __dirname, findIndexHtml(), readJsonBody(), startWebServer()

### Community 4 - "并行执行测试"
Cohesion: 0.10
Nodes (19): e2, e3, e4, e5, engine, r1, r2, r3 (+11 more)

### Community 5 - "MCP 工作流能力"
Cohesion: 0.14
Nodes (17): Additive Backward Compatibility, Agent-directed Control Flow, Server-managed Bounded Retry, Deliberate Scope Limits, Structural Group Parallelism, MCP Client Portability, Five MCP Tools, Known Limits (+9 more)

### Community 6 - "TypeScript 配置"
Cohesion: 0.12
Nodes (15): src/**/*, compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, outDir (+7 more)

### Community 7 - "协议数据模型"
Cohesion: 0.16
Nodes (11): genId(), parseWorkflow(), RunState, RunStatus, StepState, StepStatus, WorkflowDef, WorkflowStep (+3 more)

### Community 8 - "持久化恢复测试"
Cohesion: 0.14
Nodes (12): all, e1, e2, eA, eB, r1, r3, recovered (+4 more)

### Community 9 - "Web 与 SSE 测试"
Cohesion: 0.15
Nodes (7): listAfter, myRun, pending, port, proc, snapshotBefore, STORE

### Community 10 - "引擎基础测试"
Cohesion: 0.20
Nodes (8): engine, r1, r4, rewound, { runId, steps, currentIndex }, rw2, state, wf

### Community 11 - "开发依赖"
Cohesion: 0.22
Nodes (9): devDependencies, tsx, @types/js-yaml, @types/node, typescript, tsx, @types/js-yaml, @types/node (+1 more)

### Community 12 - "构建与运行脚本"
Cohesion: 0.22
Nodes (9): scripts, build, dev, prepare, prepublishOnly, start, test, typecheck (+1 more)

### Community 13 - "Agent 异常测试"
Cohesion: 0.22
Nodes (3): pending, proc, STORE

### Community 14 - "MCP 协议测试"
Cohesion: 0.29
Nodes (4): pending, proc, runIdMatch, STORE

### Community 15 - "仪表盘交互"
Cohesion: 0.47
Nodes (6): connectSSE, doDelete, doRewind, loadDetail, loadRuns, renderDetail

### Community 16 - "演示产物链"
Cohesion: 0.83
Nodes (4): Demo Context Decisions, Demo Execution Log, Demo Execution Plan, Demo Artifact Review

## Knowledge Gaps
- **143 isolated node(s):** `name`, `version`, `description`, `type`, `license` (+138 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `workflow-sm Positioning` connect `实验结论与产品化` to `MCP 工作流能力`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Why does `WorkflowEngine` connect `工作流引擎核心` to `协议数据模型`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Why does `Hard Order Guard` connect `实验结论与产品化` to `MCP 工作流能力`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `startWebServer()` (e.g. with `.delete()` and `.get()`) actually correct?**
  _`startWebServer()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _143 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `实验结论与产品化` be split into smaller, more focused modules?**
  _Cohesion score 0.07096774193548387 - nodes in this community are weakly interconnected._
- **Should `项目包与依赖` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._