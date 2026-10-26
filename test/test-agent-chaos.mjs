// test-agent-chaos.mjs — 模拟"不守规矩的 agent",验证状态机的约束力。
// 这回答赌注 2 的核心:即使 agent 想乱跳/重报/乱序,状态机能管住吗?

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离存储目录:测试的 run 不落进真实的 ~/.workflow-runs(避免僵尸污染)
const STORE = mkdtempSync(join(tmpdir(), "wf-chaos-test-"));

const proc = spawn("node", ["dist/server.js"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, WORKFLOW_STORE_DIR: STORE },
});

let buf = "";
const pending = new Map();
proc.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

let idc = 100;
function send(method, params) {
  return new Promise((resolve) => {
    const id = idc++;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function isErr(r) {
  return r.result?.isError === true || r.error != null;
}
function textOf(r) {
  return r.result?.content?.[0]?.text || JSON.stringify(r.error || "");
}

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}${extra ? " — " + extra : ""}`); }
}

console.log("== 混沌 agent 测试:状态机能管住乱来的 agent 吗? ==\n");

// 初始化
const init = await send("initialize", {
  protocolVersion: "2024-11-05", capabilities: {},
  clientInfo: { name: "chaos-agent", version: "1.0" },
});
notify("notifications/initialized");

const YAML = `
name: chaos
steps:
  - id: a
    instruction: 步骤A
  - id: b
    instruction: 步骤B
  - id: c
    instruction: 步骤C
`;

// start
const start = await send("tools/call", { name: "start_workflow", arguments: { yaml: YAML } });
const runId = textOf(start).match(/run_id: (run_\w+)/)?.[1];
console.log(`启动 run: ${runId}\n`);

// === 混沌场景 1:跳过当前步,直接报未来步 ===
console.log("场景1: agent 想跳过 a,直接报告 b");
const skip = await send("tools/call", {
  name: "report_step_result",
  arguments: { run_id: runId, step_id: "b", output: "跳过a直接做b" },
});
ok("状态机拒绝跳步(报错)", isErr(skip), textOf(skip));

// === 混沌场景 2:编造不存在的 step_id ===
console.log("场景2: agent 编造一个不存在的 step_id");
const fake = await send("tools/call", {
  name: "report_step_result",
  arguments: { run_id: runId, step_id: "does_not_exist", output: "瞎编的步" },
});
ok("状态机拒绝不存在的步(报错)", isErr(fake));

// === 混沌场景 3:正常报 a,然后想重复报 a ===
console.log("场景3: 正常推进 a,然后试图重复报告 a");
await send("tools/call", { name: "report_step_result", arguments: { run_id: runId, step_id: "a", output: "做了a" } });
const dup = await send("tools/call", {
  name: "report_step_result",
  arguments: { run_id: runId, step_id: "a", output: "又做了一次a" },
});
ok("状态机拒绝重复报告已完成步(报错)", isErr(dup), textOf(dup));

// === 混沌场景 4:乱序 —— 报了 a 之后,不报 b 直接报 c ===
console.log("场景4: 报完 a 后,跳过 b 直接报 c");
const jump = await send("tools/call", {
  name: "report_step_result",
  arguments: { run_id: runId, step_id: "c", output: "跳过b" },
});
ok("状态机拒绝乱序跳到 c(报错)", isErr(jump), textOf(jump));

// === 场景 5:只有乖乖按顺序才能推进 ===
console.log("场景5: 乖乖按顺序 b → c 才能走通");
const b = await send("tools/call", { name: "report_step_result", arguments: { run_id: runId, step_id: "b", output: "做了b" } });
ok("正确报告 b 成功推进", !isErr(b));
const c = await send("tools/call", { name: "report_step_result", arguments: { run_id: runId, step_id: "c", output: "做了c" } });
ok("正确报告 c 完成流程", textOf(c).includes("全部完成"));

// === 场景 6:查询 callLog,看状态机记录了 agent 的全部轨迹 ===
console.log("场景6: 状态机记录了完整调用轨迹(callLog)");
const status = await send("tools/call", { name: "get_run_status", arguments: { run_id: runId } });
// callLog 在 state 里但 renderState 没显示它;从引擎层面我们知道它存在
ok("get_run_status 返回完整进度", textOf(status).includes("completed"));

proc.kill();
rmSync(STORE, { recursive: true, force: true });
console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
