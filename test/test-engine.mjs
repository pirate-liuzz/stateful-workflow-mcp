// test-engine.mjs — 引擎逻辑自测(不依赖 MCP,纯状态机验证)
import { WorkflowEngine, parseWorkflow } from "../dist/engine.js";

const YAML = `
name: demo
description: 4 步演示流程
steps:
  - id: research
    description: 调研
    instruction: 产出一个主题的原始素材
  - id: analyze
    description: 分析
    instruction: 从素材中提炼要点
  - id: draft
    description: 起草
    instruction: 基于要点写草稿
  - id: save
    description: 保存
    instruction: 落盘
`;

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

console.log("== 引擎自测 ==");

// 1. 解析
const wf = parseWorkflow(YAML);
ok("解析出 4 步", wf.steps.length === 4);
ok("首步 id", wf.steps[0].id === "research");

const engine = new WorkflowEngine();

// 2. start
const { runId, steps, currentIndex } = engine.start(wf);
ok("start 后首步为 running", steps[0].status === "running");
ok("start 后其余为 pending", steps[1].status === "pending");
ok("currentIndex=0", currentIndex === 0);

// 3. 正常推进: 报告 research
const r1 = engine.reportResult(runId, "research", "素材 ABC");
ok("research 完成后 currentIndex=1", r1.state.currentIndex === 1);
ok("research 标记 completed", r1.state.steps[0].status === "completed");
ok("返回下一步 analyze", r1.nextStep?.id === "analyze");

// 4. ★ 核心守卫:跳步必须报错
let threw = false;
try {
  engine.reportResult(runId, "save", "跳到最后"); // 当前应是 analyze
} catch (e) { threw = true; }
ok("跳步被守卫拒绝", threw);

// 5. 继续正常推进到结束
engine.reportResult(runId, "analyze", "要点 123");
engine.reportResult(runId, "draft", "草稿...");
const r4 = engine.reportResult(runId, "save", "已保存");
ok("最后一步后流程 completed", r4.state.status === "completed");
ok("流程结束返回 nextStep=null", r4.nextStep === null);

// 6. 断点恢复: rewind 回 analyze 重跑
const state = engine.get(runId);
const rewound = engine.rewind(runId, "analyze");
ok("rewind 后 currentIndex 回到 analyze(index=1)", rewound.currentIndex === 1);
ok("rewind 后 analyze 重新变 running", rewound.steps[1].status === "running");
ok("rewind 后 save 重新变 pending", rewound.steps[3].status === "pending");
ok("rewind 后流程恢复 running", rewound.status === "running");

// 7. ★ 连续 rewind 回归:先回 research,再前跳到 analyze——上一次 rewind 遗留的
//    "running" 步(research)必须被归一化为 completed,不能出现双 [▶] 僵尸
engine.rewind(runId, "research");
const rw2 = engine.rewind(runId, "analyze");
ok("连续 rewind 后 research 被归一化为 completed", rw2.steps[0].status === "completed");
ok("连续 rewind 后只有 analyze 一个 running", rw2.steps.filter(s => s.status === "running").length === 1 && rw2.steps[1].status === "running");

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
