// test-parallel.mjs — Phase 2 并行 front 测试
// 覆盖:组激活(多 running)、部分 report(组内剩人)、组完成推进到下一 front、
//       组完成推进到下一个组、并行 GUARD(报非活跃兄弟被拒)、混合(组+单步)。
import { WorkflowEngine, parseWorkflow } from "../dist/engine.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ [FAIL] ${name}`); }
}

console.log("== 并行 front 测试 ==");

// 流程:fetch-a / fetch-b / fetch-c 同组(parallel)→ merge 单步 → report-a2/report-b2 同组(parallel2)
const YAML = `
name: parallel-demo
steps:
  - id: fetch-a
    group: parallel
    instruction: 抓取源 A
  - id: fetch-b
    group: parallel
    instruction: 抓取源 B
  - id: fetch-c
    group: parallel
    instruction: 抓取源 C
  - id: merge
    instruction: 合并三路结果
  - id: rep-a
    group: parallel2
    instruction: 生成报告 A
  - id: rep-b
    group: parallel2
    instruction: 生成报告 B
`;

const wf = parseWorkflow(YAML);
const engine = new WorkflowEngine();
const s = engine.start(wf);

// 1. 首组激活:fetch-a/b/c 全部 running,activeStepIds = 3 个
const st0 = engine.get(s.runId);
ok("首组 3 步全部 running", st0.steps[0].status === "running" && st0.steps[1].status === "running" && st0.steps[2].status === "running");
ok("merge 仍 pending", st0.steps[3].status === "pending");
ok("activeStepIds 含 3 个", st0.activeStepIds?.length === 3);
ok("activeStepIds 正确", JSON.stringify(st0.activeStepIds) === JSON.stringify(["fetch-a", "fetch-b", "fetch-c"]));

// 2. 部分 report:报 fetch-a,组内还剩 2,不推进
const r1 = engine.reportResult(s.runId, "fetch-a", "数据A");
ok("fetch-a 完成后 completed", engine.get(s.runId).steps[0].status === "completed");
ok("部分 report 后 activeStepIds 剩 2", engine.get(s.runId).activeStepIds?.length === 2);
ok("部分 report 后 fetch-b/c 仍 running", engine.get(s.runId).steps[1].status === "running" && engine.get(s.runId).steps[2].status === "running");
ok("部分 report 后 merge 仍 pending", engine.get(s.runId).steps[3].status === "pending");
ok("部分 report 后 nextStep=null(组内还有人)", r1.nextStep === null);

// 3. 再报 fetch-b,组内还剩 1
engine.reportResult(s.runId, "fetch-b", "数据B");
ok("报 fetch-b 后 activeStepIds 剩 1", engine.get(s.runId).activeStepIds?.length === 1);
ok("报 fetch-b 后 fetch-c 仍 running", engine.get(s.runId).steps[2].status === "running");

// 4. 报最后一个 fetch-c,组空 → 推进到下一个 front(merge 单步)
const r2 = engine.reportResult(s.runId, "fetch-c", "数据C");
ok("组完成后 activeStepIds 清空(回线性)", engine.get(s.runId).activeStepIds === undefined);
ok("组完成后 merge running", engine.get(s.runId).steps[3].status === "running");
ok("组完成后推进到 merge", r2.nextStep?.id === "merge");

// 5. merge 完成后 → 第二个组(parallel2)激活
const r3 = engine.reportResult(s.runId, "merge", "合并完成");
ok("merge 后第二组 rep-a/rep-b 都 running", engine.get(s.runId).steps[4].status === "running" && engine.get(s.runId).steps[5].status === "running");
ok("merge 后 activeStepIds 含 2 个(rep 组)", engine.get(s.runId).activeStepIds?.length === 2);
ok("返回 nextSteps 含 2 个", r3.nextSteps?.length === 2);
ok("返回 nextStep 是 rep-a(首个)", r3.nextStep?.id === "rep-a");

// 6. 报完 rep-a、rep-b → 流程 completed
engine.reportResult(s.runId, "rep-a", "报告A");
const r4 = engine.reportResult(s.runId, "rep-b", "报告B");
ok("全部完成后 run completed", engine.get(s.runId).status === "completed");
ok("全部完成后 nextStep=null", r4.nextStep === null);

// ---- 并行 GUARD:报非活跃兄弟被拒 ----
const e2 = new WorkflowEngine();
const s2 = e2.start(wf);
// 活跃集 = {fetch-a, fetch-b, fetch-c}。报 merge(非活跃)应被拒
let threw = false;
try { e2.reportResult(s2.runId, "merge", "x"); }
catch { threw = true; }
ok("并行模式报非活跃步(merge)被拒", threw);

// 报一个不存在的
threw = false;
try { e2.reportResult(s2.runId, "ghost", "x"); }
catch { threw = true; }
ok("并行模式报不存在步被拒", threw);

// 报完 fetch-a 后,再报 fetch-a(已不在活跃集)应被拒
e2.reportResult(s2.runId, "fetch-a", "done");
threw = false;
try { e2.reportResult(s2.runId, "fetch-a", "again"); }
catch { threw = true; }
ok("报已完成的并行兄弟被拒(防重复)", threw);

// ---- 线性流程不受 group 影响(无 group 字段 = 完全线性)----
const LINEAR = `name: lin\nsteps:\n  - id: a\n  - id: b\n  - id: c`;
const e3 = new WorkflowEngine();
const s3 = e3.start(parseWorkflow(LINEAR));
ok("线性流程 activeStepIds 为 undefined", e3.get(s3.runId).activeStepIds === undefined);
ok("线性流程只有首步 running", e3.get(s3.runId).steps[0].status === "running" && e3.get(s3.runId).steps[1].status === "pending");
const rl = e3.reportResult(s3.runId, "a", "a");
ok("线性流程 report 后正常推进", rl.nextStep?.id === "b");

// ---- rewind 到并行组:应重新激活整组(不是单步) ----
const e4 = new WorkflowEngine();
const s4 = e4.start(wf);
// 跑完首组 + merge,推进到第二组
e4.reportResult(s4.runId, "fetch-a", "A");
e4.reportResult(s4.runId, "fetch-b", "B");
e4.reportResult(s4.runId, "fetch-c", "C");
e4.reportResult(s4.runId, "merge", "M");
// 现在第二组(rep-a/rep-b)是活跃的。rewind 回 fetch-a(首组成员)
const rw = e4.rewind(s4.runId, "fetch-a");
ok("rewind 到组内步:整组重新激活", rw.activeStepIds?.length === 3);
ok("rewind 到组:fetch-a/b/c 都 running", rw.steps[0].status === "running" && rw.steps[1].status === "running" && rw.steps[2].status === "running");
ok("rewind 到组:merge 回到 pending", rw.steps[3].status === "pending");
ok("rewind 到组:组内步的 output 被清空", rw.steps[0].output === null && rw.steps[1].output === null);

// rewind 到单步(merge):应只激活 merge,无并行组
const e5 = new WorkflowEngine();
const s5 = e5.start(wf);
e5.reportResult(s5.runId, "fetch-a", "A");
e5.reportResult(s5.runId, "fetch-b", "B");
e5.reportResult(s5.runId, "fetch-c", "C");
const rw2 = e5.rewind(s5.runId, "merge");
ok("rewind 到单步:无并行组(activeStepIds 空)", rw2.activeStepIds === undefined);
ok("rewind 到单步:仅 merge running", rw2.steps[3].status === "running");
ok("rewind 到单步:merge 之后步骤 pending", rw2.steps[4].status === "pending");

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
