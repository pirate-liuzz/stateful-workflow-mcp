// web.ts — HTTP + SSE 桥接层,把 engine 暴露给浏览器看板。
// 单进程内和 MCP stdio transport 并发跑。零依赖(只用 Node 内置 http)。
// 设计:engine 是内存真相,HTTP 层只读 + rewind 回写;状态变更经 SSE 实时推送。

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowEngine } from "./engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 查看器模式(WORKFLOW_VIEWER_SYNC=1):每次读接口前重新同步磁盘,
// 让常驻实例看到其他实例(agent 会话)新写入的 run。会话实例不开启(保护自己的内存真相)。
const VIEWER_SYNC = process.env.WORKFLOW_VIEWER_SYNC === "1";
// dist/web.js → 同级或上一级的 web/index.html(兼顾 dist 和 src 运行)
function findIndexHtml(): string {
  const candidates = [
    join(__dirname, "..", "web", "index.html"), // dist/web.js → ../web/
    join(__dirname, "..", "..", "web", "index.html"), // src/web.ts(经 tsx)→ ../../web/
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return candidates[0];
}

/** 启动 HTTP+SSE 看板服务器。端口占用自动 +1 fallback。返回实际端口。 */
export function startWebServer(
  engine: WorkflowEngine,
  preferredPort: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    // SSE 客户端列表
    const sseClients = new Set<ServerResponse>();

    // 订阅 engine 状态变更 → 推给所有连着的浏览器
    engine.setOnChange((runId) => {
      const payload = `event: change\ndata: ${JSON.stringify({ runId })}\n\n`;
      for (const res of sseClients) {
        try { res.write(payload); } catch { sseClients.delete(res); }
      }
    });

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const path = url.pathname;
      // 注:看板与接口同源,无需 CORS;不设 Access-Control-Allow-Origin,
      // 防止浏览器里其他网页跨源调用本机接口(含 launch 这类开窗口的端点)。

      // GET / → 看板页面
      if (req.method === "GET" && path === "/") {
        try {
          const html = readFileSync(findIndexHtml(), "utf8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "index.html 未找到", detail: String(e) }));
        }
        return;
      }

      // GET /api/runs → 所有 run 列表(含 def)
      if (req.method === "GET" && path === "/api/runs") {
        if (VIEWER_SYNC) engine.reloadFromDisk();
        const runs = engine.listRuns().map((r) => ({
          state: r,
          def: engine.getDef(r.runId),
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(runs));
        return;
      }

      // GET /api/events → SSE 长连接
      if (req.method === "GET" && path === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        res.write(": connected\n\n"); // 握手注释
        // 连上时先推一次全量,让客户端立即有数据
        res.write(`event: snapshot\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);
        sseClients.add(res);
        // 心跳(每 25s),防止代理掐断空闲连接
        const heartbeat = setInterval(() => {
          try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* 客户端已断 */ }
        }, 25000);
        req.on("close", () => {
          clearInterval(heartbeat);
          sseClients.delete(res);
        });
        return;
      }

      // GET /api/runs/:id → 单个 run 详情;DELETE /api/runs/:id → 删除该 run
      const detailMatch = path.match(/^\/api\/runs\/(run_\w+)$/);
      if (detailMatch) {
        const runId = detailMatch[1];
        if (req.method === "GET") {
          if (VIEWER_SYNC) engine.reloadFromDisk();
          const state = engine.get(runId);
          if (!state) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `run_id 不存在: ${runId}` }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ state, def: engine.getDef(runId) }));
          return;
        }
        if (req.method === "DELETE") {
          if (VIEWER_SYNC) engine.reloadFromDisk();
          try {
            engine.delete(runId);
            // 广播给所有看板刷新(选中该 run 的页面会因 404 自动清空选中)
            const payload = `event: change\ndata: ${JSON.stringify({ runId })}\n\n`;
            for (const r of sseClients) {
              try { r.write(payload); } catch { sseClients.delete(r); }
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, deleted: runId }));
          } catch (e) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: (e as Error).message }));
          }
          return;
        }
      }

      // POST /api/runs/:id/rewind { to_step_id } → 倒带
      const rewindMatch = path.match(/^\/api\/runs\/(run_\w+)\/rewind$/);
      if (req.method === "POST" && rewindMatch) {
        if (VIEWER_SYNC) engine.reloadFromDisk();
        const runId = rewindMatch[1];
        const body = await readJsonBody(req);
        if (!body?.to_step_id) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "需要 to_step_id" }));
          return;
        }
        try {
          const state = engine.rewind(runId, body.to_step_id);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ state, def: engine.getDef(runId) }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
        return;
      }

      // POST /api/runs/:id/launch { client: "claude"|"codex" }
      // → 在新终端窗口启动对应 agent 并带上续跑提示词(agent 才是执行者,server 只开窗口)
      const launchMatch = path.match(/^\/api\/runs\/(run_\w+)\/launch$/);
      if (req.method === "POST" && launchMatch) {
        if (VIEWER_SYNC) engine.reloadFromDisk();
        const runId = launchMatch[1];
        const body = await readJsonBody(req);
        const client = body?.client;
        if (client !== "claude" && client !== "codex") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "client 只支持 claude 或 codex" }));
          return;
        }
        if (!engine.get(runId)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `run_id 不存在: ${runId}` }));
          return;
        }
        const prompt =
          `用 workflow-sm 续跑断点 ${runId}: 先调 get_run_status 查看 [▶] 当前步与之前各步产出,` +
          `执行该步任务后用 report_step_result 报告(run_id 填 ${runId}),循环直到 completed,严禁跳步或重报已完成步骤。`;
        let spawned = true;
        if (process.env.WORKFLOW_LAUNCH_DISABLED === "1") {
          spawned = false; // 测试模式:不真弹窗口
        } else if (process.platform === "win32") {
          try {
            spawn(
              "cmd.exe",
              ["/c", "start", '""', "cmd.exe", "/k", `${client} "${prompt}"`],
              { detached: true, stdio: "ignore", windowsVerbatimArguments: true },
            ).unref();
          } catch { spawned = false; }
        } else {
          spawned = false; // 非 Windows 暂不支持一键续跑
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, client, spawned, platform: process.platform }));
        return;
      }

      // POST /api/runs/:id/refresh → 触发一次 SSE 推送(手动刷新按钮)
      const refreshMatch = path.match(/^\/api\/runs\/(run_\w+)\/refresh$/);
      if (req.method === "POST" && refreshMatch) {
        const runId = refreshMatch[1];
        // 直接推一次 change 事件(无需真正改状态)
        const payload = `event: change\ndata: ${JSON.stringify({ runId })}\n\n`;
        for (const r of sseClients) {
          try { r.write(payload); } catch { sseClients.delete(r); }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `未知路由: ${req.method} ${path}` }));
    });

    // 端口 fallback:占用则试下一个
    let attempts = 0;
    const maxAttempts = 10;
    const tryListen = (port: number) => {
      server.listen(port, "127.0.0.1");
    };
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && attempts < maxAttempts) {
        attempts++;
        const nextPort = preferredPort + attempts;
        server.listen(nextPort, "127.0.0.1");
      } else {
        reject(err);
      }
    });
    server.on("listening", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : preferredPort;
      // 写入 .web-port 供发现(跟随存储目录,测试隔离时不污染真实目录)
      try {
        const home = process.env.HOME || process.env.USERPROFILE || "";
        const storeDir = process.env.WORKFLOW_STORE_DIR || join(home, ".workflow-runs");
        if (home) {
          if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
          writeFileSync(join(storeDir, ".web-port"), String(port), "utf8");
        }
      } catch { /* 发现文件非关键路径 */ }
      console.error(`[workflow-mcp] 看板: http://127.0.0.1:${port}`);
      resolve(port);
    });

    tryListen(preferredPort);
  });
}

/** 读 POST 请求体并解析 JSON。 */
function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({}); }
    });
  });
}
