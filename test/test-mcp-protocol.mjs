// test-mcp-protocol.mjs — MCP 协议级自测
// 直接用 stdio 和 server 进程对话,模拟任意 MCP 客户端。
// 这同时验证了"可移植性赌注":任何 MCP 客户端走的是同一套 JSON-RPC 协议。
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离存储目录:测试的 run 不落进真实的 ~/.workflow-runs(避免僵尸污染)
const STORE = mkdtempSync(join(tmpdir(), "wf-proto-test-"));

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

function send(obj) {
  return new Promise((resolve) => {
    pending.set(obj.id, resolve);
    proc.stdin.write(JSON.stringify(obj) + "\n");
  });
}

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
}

console.log("== MCP 协议级自测 ==");

// 1. initialize
const init = await send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test-client", version: "1.0" } },
});
ok("initialize 成功", init.result?.serverInfo?.name === "workflow-state-machine");

// initialized 通知(无 id)
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
await new Promise((r) => setTimeout(r, 200));

// 2. tools/list
const list = await send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const toolNames = list.result?.tools?.map((t) => t.name) || [];
ok("暴露 5 个工具", toolNames.length === 5);
ok("有 start_workflow", toolNames.includes("start_workflow"));
ok("有 report_step_result", toolNames.includes("report_step_result"));
ok("有 get_run_status", toolNames.includes("get_run_status"));
ok("有 list_runs", toolNames.includes("list_runs"));
ok("有 rewind", toolNames.includes("rewind"));

// 3. tools/call: start_workflow
const YAML = `
name: proto-test
description: 协议测试
steps:
  - id: s1
    instruction: 第一步
  - id: s2
    instruction: 第二步
`;
const start = await send({
  jsonrpc: "2.0", id: 3, method: "tools/call",
  params: { name: "start_workflow", arguments: { yaml: YAML } },
});
const startText = start.result?.content?.[0]?.text || "";
const runIdMatch = startText.match(/run_id: (run_\w+)/);
ok("start 返回 run_id", !!runIdMatch);
// s1 没绑 skill → 自然语言措辞"现在执行这一步"
ok("start 返回首步指令(无skill,自然语言)", startText.includes("现在执行这一步") && startText.includes("s1"));
const runId = runIdMatch?.[1];

// 4. tools/call: report_step_result (正确步)
const rep1 = await send({
  jsonrpc: "2.0", id: 4, method: "tools/call",
  params: { name: "report_step_result", arguments: { run_id: runId, step_id: "s1", output: "第一步结果" } },
});
ok("report s1 后返回 s2", rep1.result?.content?.[0]?.text?.includes("s2"));

// 5. tools/call: report_step_result (跳步错误 — 守卫)
const repBad = await send({
  jsonrpc: "2.0", id: 5, method: "tools/call",
  params: { name: "report_step_result", arguments: { run_id: runId, step_id: "s1", output: "重复报告已完成的步" } },
});
ok("重复报告已完成步 → 报错", repBad.result?.isError === true);

// 6. tools/call: get_run_status
const status = await send({
  jsonrpc: "2.0", id: 6, method: "tools/call",
  params: { name: "get_run_status", arguments: { run_id: runId } },
});
ok("get_run_status 返回进度", status.result?.content?.[0]?.text?.includes("s1") && status.result?.content?.[0]?.text?.includes("s2"));

proc.kill();
rmSync(STORE, { recursive: true, force: true });
console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
