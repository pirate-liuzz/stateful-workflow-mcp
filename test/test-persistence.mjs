// test-persistence.mjs — 验证 demo 的两个新能力:
// 1. skill 字段解析 + 返回的 nextStep 带 skill/args
// 2. 文件持久化 + 断点恢复(start → 模拟进程退出 → 新 engine loadAll → 状态完整)

import { rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowEngine, parseWorkflow } from "../dist/engine.js";

const STORE = join(tmpdir(), `wf-test-${Date.now()}`);
rmSync(STORE, { recursive: true, force: true });

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}${extra ? " — " + extra : ""}`); }
}

console.log("== Demo 新功能测试 ==\n");

// ---- 1. skill 字段解析 ----
console.log("[1] skill 字段解析");
const YAML_SKILL = `
name: skill-demo
steps:
  - id: discuss
    skill: gsd-discuss-phase
    args: "--analyze"
    instruction: 收集上下文
  - id: review
    skill: gsd-code-review
    instruction: 审查代码
  - id: manual
    instruction: 没绑skill的普通步
`;
const wf = parseWorkflow(YAML_SKILL);
ok("解析出 3 步", wf.steps.length === 3);
ok("step1 绑了 skill", wf.steps[0].skill === "gsd-discuss-phase");
ok("step1 带 args", wf.steps[0].args === "--analyze");
ok("step2 绑了 skill", wf.steps[1].skill === "gsd-code-review");
ok("step3 没绑 skill(und­efined)", wf.steps[2].skill === undefined);

// ---- 2. nextStep 返回时带 skill/args ----
console.log("\n[2] nextStep 返回带 skill 信息");
const e1 = new WorkflowEngine(STORE);
const s = e1.start(wf);
ok("首步是 discuss(绑skill)", s.steps[0].id === "discuss");
const r1 = e1.reportResult(s.runId, "discuss", "上下文产出");
ok("推进后 nextStep 带 skill=gsd-code-review", r1.nextStep?.skill === "gsd-code-review");
ok("推进后 nextStep 带 instruction", r1.nextStep?.instruction === "审查代码");

// ---- 3. ★ 持久化 + 断点恢复(核心) ----
console.log("\n[3] 持久化 + 断点恢复");
// 模拟:跑完第1步,然后"进程退出"(丢弃 e1,只留磁盘文件)
e1.reportResult(s.runId, "review", "审查产出"); // 跑到第3步(manual)
// 现在 run 处于:discuss✓ review✓ manual▶,中断在这里

ok("磁盘上有 run 文件", existsSync(join(STORE, `${s.runId}.json`)));

// 模拟 server 重启:创建全新 engine,loadAll 恢复
const e2 = new WorkflowEngine(STORE);
e2.loadAll();
const recovered = e2.get(s.runId);
ok("重启后 run 仍在", recovered !== undefined);
ok("恢复后 workflowName 正确", recovered?.workflowName === "skill-demo");
ok("恢复后 discuss 状态=completed", recovered?.steps[0].status === "completed");
ok("恢复后 review 状态=completed", recovered?.steps[1].status === "completed");
ok("恢复后 manual 状态=running(中断点)", recovered?.steps[2].status === "running");
ok("恢复后 currentIndex=2(该从 manual 继续)", recovered?.currentIndex === 2);
ok("恢复后 各步 output 完整保留", recovered?.steps[0].output === "上下文产出" && recovered?.steps[1].output === "审查产出");

// 接着跑:从恢复的 engine 继续推进
const r3 = e2.reportResult(s.runId, "manual", "手动步产出");
ok("断点恢复后能接着推进到完成", r3.state.status === "completed" && r3.nextStep === null);

// ---- 4. listRuns ----
console.log("\n[4] listRuns");
const all = e2.listRuns();
ok("listRuns 返回 1 个 run", all.length === 1);
ok("listRuns 包含完成的 run", all[0].status === "completed");

// ---- 5. reloadFromDisk(查看器模式:同步其他实例写入的最新状态) ----
console.log("\n[5] reloadFromDisk 查看器同步");
const eA = new WorkflowEngine(STORE);
const sA = eA.start(parseWorkflow("name: sync-demo\nsteps:\n  - id: a\n  - id: b"));
const eB = new WorkflowEngine(STORE);
eB.loadAll(); // B 先加载(此刻只有 a 未完成)
ok("B 初始能看到 A 的新 run", eB.get(sA.runId) !== undefined);
eA.reportResult(sA.runId, "a", "A 实例推进了");
ok("B 不会实时看到 A 的推进(内存隔离)", eB.get(sA.runId)?.steps[0].status !== "completed");
eB.reloadFromDisk();
ok("reloadFromDisk 后 B 同步到 A 的推进", eB.get(sA.runId)?.steps[0].status === "completed");
eA.delete(sA.runId);
eB.reloadFromDisk();
ok("reloadFromDisk 后 B 同步到删除(run 消失)", eB.get(sA.runId) === undefined);

// 清理
rmSync(STORE, { recursive: true, force: true });

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
