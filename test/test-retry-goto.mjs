// test-retry-goto.mjs — Phase 1 新能力测试:重试 + agent 显式 goto
// 覆盖 max_attempts 耗尽/恢复、next_step_id 前跳/后跳/循环、非法 goto、status 默认兼容。
import { WorkflowEngine, parseWorkflow } from "../dist/engine.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ [FAIL] ${name}`); }
}

console.log("== 重试 + goto 测试 ==");

// ---- 解析校验:max_attempts ----
let threw = false;
try {
  parseWorkflow(`name: x\nsteps:\n  - id: a\n    max_attempts: 0`);
} catch { threw = true; }
ok("max_attempts=0 被拒绝", threw);

threw = false;
try {
  parseWorkflow(`name: x\nsteps:\n  - id: a\n    max_attempts: 1.5`);
} catch { threw = true; }
ok("max_attempts 非整数被拒绝", threw);

const ok2 = parseWorkflow(`name: x\nsteps:\n  - id: a\n    max_attempts: 3`);
ok("max_attempts=3 被正确解析", ok2.steps[0].max_attempts === 3);

// ---- 重试:耗尽后 run failed ----
const RETRY = `
name: retry-demo
steps:
  - id: flaky
    max_attempts: 3
    instruction: 一个会失败重试的步骤
  - id: after
    instruction: 重试成功后的下一步
`;
const e1 = new WorkflowEngine();
const wf1 = parseWorkflow(RETRY);
const s1 = e1.start(wf1);

// 第一次失败:attempts=1,还能重试,返回自己
const f1 = e1.reportResult(s1.runId, "flaky", "失败1", "failure");
ok("失败1 后 attempts=1", e1.get(s1.runId).steps[0].attempts === 1);
ok("失败1 后该步仍 running", e1.get(s1.runId).steps[0].status === "running");
ok("失败1 后 nextStep 返回自己(flaky)", f1.nextStep?.id === "flaky");

// 第二次失败:attempts=2,还能重试
const f2 = e1.reportResult(s1.runId, "flaky", "失败2", "failure");
ok("失败2 后 attempts=2", e1.get(s1.runId).steps[0].attempts === 2);
ok("失败2 后仍 running(未耗尽)", e1.get(s1.runId).steps[0].status === "running");

// 第三次失败:attempts=3 = max,耗尽 → failed
const f3 = e1.reportResult(s1.runId, "flaky", "失败3", "failure");
ok("失败3 后 attempts=3", e1.get(s1.runId).steps[0].attempts === 3);
ok("耗尽后该步 failed", e1.get(s1.runId).steps[0].status === "failed");
ok("耗尽后 run failed", e1.get(s1.runId).status === "failed");
ok("耗尽后 nextStep=null", f3.nextStep === null);

// 耗尽后再 report 应被拒(run 已 failed)
threw = false;
try { e1.reportResult(s1.runId, "flaky", "x"); }
catch { threw = true; }
ok("run failed 后再 report 被拒", threw);

// ---- 重试:中途成功后正常推进 ----
const e2 = new WorkflowEngine();
const s2 = e2.start(wf1);
e2.reportResult(s2.runId, "flaky", "失败一次", "failure");
const ok3 = e2.reportResult(s2.runId, "flaky", "这次成功了");
ok("重试中途成功后推进到 after", ok3.nextStep?.id === "after");
ok("重试成功后 flaky completed", e2.get(s2.runId).steps[0].status === "completed");
ok("重试成功后 attempts 保留为 1", e2.get(s2.runId).steps[0].attempts === 1);

// ---- status 默认 = success(兼容)----
const e3 = new WorkflowEngine();
const s3 = e3.start(wf1);
const def = e3.reportResult(s3.runId, "flaky", "不传 status");
ok("不传 status 默认按 success 推进", def.nextStep?.id === "after");
ok("不传 status 时 attempts 保持 0", e3.get(s3.runId).steps[0].attempts === 0);

// ---- agent goto:向前跳 ----
const LINEAR = `
name: linear
steps:
  - id: a
  - id: b
  - id: c
  - id: d
`;
const e4 = new WorkflowEngine();
const s4 = e4.start(parseWorkflow(LINEAR));
// a 成功,goto 跳过 b 直接到 d
const g1 = e4.reportResult(s4.runId, "a", "a done", "success", "d");
ok("goto d 后 currentIndex 在 d", e4.get(s4.runId).steps[3].status === "running");
ok("goto d 后 b/c 仍 pending", e4.get(s4.runId).steps[1].status === "pending" && e4.get(s4.runId).steps[2].status === "pending");
ok("goto 返回 nextStep=d", g1.nextStep?.id === "d");

// ---- agent goto:向后回退(循环重做)----
const e5 = new WorkflowEngine();
const s5 = e5.start(parseWorkflow(LINEAR));
e5.reportResult(s5.runId, "a", "a");
e5.reportResult(s5.runId, "b", "b");
// 现在到 c,回退到 a 重新做
const g2 = e5.reportResult(s5.runId, "c", "c done", "success", "a");
ok("回退到 a 后 a 重新 running", e5.get(s5.runId).steps[0].status === "running");
ok("回退后 a 的 attempts 清零", e5.get(s5.runId).steps[0].attempts === 0);
ok("回退后 nextStep=a", g2.nextStep?.id === "a");
ok("回退后 a 的旧 output 被清空", e5.get(s5.runId).steps[0].output === null);

// ---- agent goto:非法目标被拒 ----
const e6 = new WorkflowEngine();
const s6 = e6.start(parseWorkflow(LINEAR));
threw = false;
try { e6.reportResult(s6.runId, "a", "a", "success", "does_not_exist"); }
catch { threw = true; }
ok("goto 不存在的 step 被拒", threw);

// ---- goto 在 failure 时不生效(只有 success 才 goto)----
const e7 = new WorkflowEngine();
const s7 = e7.start(wf1);
const g3 = e7.reportResult(s7.runId, "flaky", "fail+goto", "failure", "after");
ok("failure 时不执行 goto(走重试分支)", g3.nextStep?.id === "flaky");

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
