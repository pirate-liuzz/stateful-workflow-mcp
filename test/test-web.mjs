// test-web.mjs — 可视化看板(HTTP+SSE)集成测试
// 起完整 server 子进程(MCP stdio + HTTP 看板),验证:看板页面、API、SSE 实时、rewind。
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 用独立端口避免和其他测试的 server 子进程争用 7777。
// 通过环境变量传端口(server 读 WEB_PORT;若硬编码则这里读 stderr 兜底)。
const TEST_PORT = 7910;
// 隔离存储目录:测试的 run 不落进真实的 ~/.workflow-runs(避免僵尸污染)
const STORE = mkdtempSync(join(tmpdir(), "wf-web-test-"));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ [FAIL] ${name}`); }
}

console.log("== 可视化看板测试 ==");

// 起 server,捕获 stderr 拿实际看板端口(可能 fallback)
const proc = spawn("node", ["dist/server.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, WEB_PORT: String(TEST_PORT), WORKFLOW_STORE_DIR: STORE, WORKFLOW_LAUNCH_DISABLED: "1" },
});

let stderrBuf = "";
proc.stderr?.on("data", (c) => { stderrBuf += c.toString(); });

// JSON-RPC 样板
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

// 等待 stderr 出现看板端口
function getWebPort() {
  const m = stderrBuf.match(/127\.0\.0\.1:(\d+)/);
  return m ? Number(m[1]) : TEST_PORT;
}

// SSE 客户端(用原始 http,Node 无全局 EventSource)
function openSSE(port) {
  return new Promise((resolve) => {
    const events = [];
    const req = http.get(`http://127.0.0.1:${port}/api/events`, (res) => {
      let b = "";
      res.on("data", (c) => {
        b += c.toString();
        // 按双换行切 SSE 事件块
        let i;
        while ((i = b.indexOf("\n\n")) >= 0) {
          const block = b.slice(0, i);
          b = b.slice(i + 2);
          const typeMatch = block.match(/^event: (.+)$/m);
          if (typeMatch) events.push(typeMatch[1]);
        }
      });
    });
    // 防止 server 关闭时 ECONNRESET 抛未捕获异常
    req.on("error", () => {});
    resolve({ events, req });
  });
}

// 等待 server 起来
await new Promise((r) => setTimeout(r, 600));
const port = getWebPort();
ok("server 启动并打印看板端口", stderrBuf.includes("看板:"));

// 1. GET / 返回看板 HTML
const r1 = await fetch(`http://127.0.0.1:${port}/`);
const html = await r1.text();
ok("GET / 返回 200", r1.status === 200);
ok("HTML 含看板标题", html.includes("workflow-sm 看板"));
ok("HTML 含 SSE 脚本", html.includes("EventSource"));

// 2. MCP initialize + start_workflow(经 stdio 起一个 run)
await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "web-test", version: "1" } } });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
await new Promise((r) => setTimeout(r, 150));
const start = await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "start_workflow", arguments: { yaml: "name: webt\nsteps:\n  - id: a\n  - id: b\n  - id: c" } } });
const startText = start.result?.content?.[0]?.text || "";
const runId = startText.match(/run_id: (run_\w+)/)?.[1];
ok("stdio MCP start 成功", !!runId);

// 3. GET /api/runs 能看到这个 run
const r3 = await fetch(`http://127.0.0.1:${port}/api/runs`);
const j3 = await r3.json();
ok("/api/runs 返回数组", Array.isArray(j3));
const myRun = j3.find((x) => x.state.runId === runId);
ok("/api/runs 含刚起的 run", !!myRun);
ok("run 含 def", !!myRun?.def);
ok("run 含 state.steps", Array.isArray(myRun?.state?.steps));

// 4. GET /api/runs/:id 详情
const r4 = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}`);
const j4 = await r4.json();
ok("/api/runs/:id 返回 state+def", j4.state?.runId === runId && Array.isArray(j4.def?.steps));

// 5. GET 不存在的 run → 404
const r5 = await fetch(`http://127.0.0.1:${port}/api/runs/run_nonexistent`);
ok("不存在的 run → 404", r5.status === 404);

// 6. SSE:连上后推进 run,应收到 change 事件
const { events } = await openSSE(port);
await new Promise((r) => setTimeout(r, 150)); // 等 SSE 连上 + snapshot
const snapshotBefore = events.includes("snapshot");
ok("SSE 连上收到 snapshot", snapshotBefore);

await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "report_step_result", arguments: { run_id: runId, step_id: "a", output: "A done" } } });
await new Promise((r) => setTimeout(r, 200));
ok("推进后 SSE 收到 change 事件", events.includes("change"));

// 7. /api/runs 反映推进(a completed, b running)
const r7 = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}`);
const j7 = await r7.json();
ok("推进后 a completed", j7.state.steps[0].status === "completed");
ok("推进后 b running", j7.state.steps[1].status === "running");

// 8. POST rewind 倒带
const r8 = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/rewind`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ to_step_id: "a" }),
});
const j8 = await r8.json();
ok("rewind 返回 200", r8.status === 200);
ok("rewind 后 a 重新 running", j8.state?.steps?.[0]?.status === "running");
ok("rewind 后 b 回到 pending", j8.state?.steps?.[1]?.status === "pending");

// 9. rewind 缺 to_step_id → 400
const r9 = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/rewind`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
ok("rewind 缺参数 → 400", r9.status === 400);

// 10. POST refresh 触发推送
const r10 = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/refresh`, { method: "POST" });
ok("refresh 返回 200", r10.status === 200);

// 11. 未知路由 → 404
const r11 = await fetch(`http://127.0.0.1:${port}/api/unknown`);
ok("未知路由 → 404", r11.status === 404);

// 12. POST launch:一键续跑(client 白名单;测试模式不真弹窗)
const r12l = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/launch`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ client: "evil-command" }),
});
ok("launch 非法 client → 400(白名单)", r12l.status === 400);
const r12l2 = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/launch`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ client: "claude" }),
});
ok("launch claude → 200", r12l2.status === 200);

// 13. DELETE /api/runs/:id → 删除 run(内存 + 磁盘)
const r12 = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}`, { method: "DELETE" });
ok("DELETE 返回 200", r12.status === 200);
const r12b = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}`);
ok("删除后 GET → 404", r12b.status === 404);
const listAfter = await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json();
ok("删除后不在 run 列表里", !listAfter.find((x) => x.state.runId === runId));
ok("磁盘状态文件也被删除", !(await import("node:fs")).existsSync(join(STORE, `${runId}.json`)));
const r12c = await fetch(`http://127.0.0.1:${port}/api/runs/run_nonexistent`, { method: "DELETE" });
ok("DELETE 不存在的 run → 404", r12c.status === 404);

proc.kill();
rmSync(STORE, { recursive: true, force: true });
await new Promise((r) => setTimeout(r, 100));
console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
