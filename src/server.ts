#!/usr/bin/env node
// server.ts — stateful MCP workflow engine(产品级)。
// 把状态机引擎暴露成 MCP 工具,让 agent 严格驱动推进。
// 能力:线性推进 + 并行组(group)+ 重试(max_attempts)+ agent 自主跳转(next_step_id)+ 断点恢复 + rewind。
//
// 五个工具:
//   1. start_workflow(yaml)      → 开始,返回 run_id + 第一步指令
//   2. report_step_result(...)   → 报告结果(可选 status / next_step_id),推进状态机
//   3. get_run_status(run_id)    → 查看当前进度(支持断点恢复观察)
//   4. list_runs(only_incomplete)→ 列出所有 run(找中断的可恢复)
//   5. rewind(run_id, to_step_id)→ 倒带回退到某步重跑

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  WorkflowEngine,
  parseWorkflow,
  type RunState,
  type WorkflowDef,
  type WorkflowStep,
} from "./engine.js";
import { startWebServer } from "./web.js";

// 持久化目录:用户主目录下 .workflow-runs/(跨项目共享,server 重启后能恢复)
// 可用 WORKFLOW_STORE_DIR 环境变量覆盖(测试隔离用)
const STORE_DIR = process.env.WORKFLOW_STORE_DIR || join(homedir(), ".workflow-runs");
const engine = new WorkflowEngine(STORE_DIR);
engine.loadAll(); // 启动时恢复历史 run

// 看板 HTTP 端口(占用自动 +1 fallback;可用 WEB_PORT 环境变量覆盖)
const WEB_PORT = Number(process.env.WEB_PORT) || 7777;

// 把 RunState 渲染成 agent 易读的文本
function renderState(state: RunState): string {
  const lines: string[] = [];
  lines.push(`run_id: ${state.runId}`);
  lines.push(`status: ${state.status}`);
  // 线性模式:currentIndex = 当前步;并行模式:活跃步数显示在 progress 行
  const activeCount = state.activeStepIds?.length ?? 0;
  const doneCount = state.steps.filter((s) => s.status === "completed").length;
  if (activeCount > 1) {
    lines.push(`progress: ${doneCount}/${state.steps.length} steps(并行中: ${activeCount} 步在跑)`);
  } else {
    lines.push(`progress: ${doneCount}/${state.steps.length} steps`);
  }
  lines.push(`---`);
  for (const s of state.steps) {
    const mark =
      s.status === "completed" ? "[✓]"
      : s.status === "running" ? "[▶]"
      : s.status === "failed" ? "[✗]"
      : "[ ]";
    const out = s.output ? ` → ${(s.output as string).slice(0, 80)}${(s.output as string).length > 80 ? "..." : ""}` : "";
    const retryTag = s.status === "running" && s.attempts > 0 ? ` (重试 ${s.attempts})` : "";
    lines.push(`${mark} ${s.id}${retryTag}${out}`);
  }
  return lines.join("\n");
}

// 把"当前该做什么"渲染成 agent 能直接执行的指令。
// 绑了 skill → 明确告诉 agent 调用 /skill-name(半自动:agent 在对话里跑,可能问用户问题)
// 没绑 skill → 用自然语言 instruction
function renderStepAction(step: WorkflowStep, runId?: string): string {
  const reportHint = runId
    ? `执行完后调用 report_step_result(run_id="${runId}", step_id="${step.id}", output="...")。`
    : `执行完后调用 report_step_result 报告结果。`;
  if (step.skill) {
    const args = step.args ? `(参数: ${step.args})` : "";
    const hint = step.instruction ? `\n说明: ${step.instruction}` : "";
    return [
      `━━━ 现在请调用 skill ━━━`,
      `调用 /${step.skill}${args}`,
      ``,
      `在对话里运行这个 skill(它可能会问你问题,正常回答即可)。`,
      `跑完后,把它的产出/结果作为 output 报告回来。${hint}`,
      ``,
      reportHint,
    ].join("\n");
  }
  return [
    `━━━ 现在执行这一步 ━━━`,
    `step_id: ${step.id}`,
    `instruction: ${step.instruction}`,
    ``,
    reportHint,
  ].join("\n");
}

const server = new McpServer(
  { name: "workflow-state-machine", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ---- 工具 1: start_workflow ----
server.tool(
  "start_workflow",
  `开始一个工作流。传入完整的 YAML 定义。返回 run_id 和第一个步骤的指令。
之后你必须:执行该步骤 → 调用 report_step_result 报告结果 → 拿到下一步 → 重复,直到流程结束。`,
  {
    yaml: z.string().describe("工作流的 YAML 定义,包含 name 和 steps[]"),
  },
  async ({ yaml: yamlText }) => {
    let workflow: WorkflowDef;
    try {
      workflow = parseWorkflow(yamlText);
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `❌ YAML 解析失败: ${(e as Error).message}`,
          },
        ],
      };
    }
    const state = engine.start(workflow);
    const firstStep = workflow.steps[0];
    const text = [
      `✅ 工作流已开始`,
      ``,
      renderState(state),
      ``,
      renderStepAction(firstStep, state.runId),
    ].join("\n");
    return { content: [{ type: "text", text }] };
  },
);

// ---- 工具 2: report_step_result ----
server.tool(
  "report_step_result",
  `报告当前步骤的执行结果,推进状态机。
重要:只能报告"当前活跃集"里的步骤(见 get_run_status 里标记 [▶] 的;并行模式下同组多个步都是活跃的)。
可选参数:
  - status: "success"(默认)或 "failure"。failure 会触发重试(若该步设了 max_attempts);耗尽则该步失败、整个 run 失败。
  - next_step_id: 成功后显式跳转到指定步骤(向前推进 / 向后回退 / 循环重做)。不传 = 按定义顺序线性推进。
返回下一步指令,或提示流程已结束 / 组内还有并行步在跑。`,
  {
    run_id: z.string().describe("start_workflow 返回的 run_id"),
    step_id: z.string().describe("刚执行完的步骤 id(必须在当前活跃集里)"),
    output: z.string().describe("这一步的执行结果(会传给下一步作为上下文)"),
    status: z
      .enum(["success", "failure"])
      .optional()
      .describe("默认 success。failure 触发重试逻辑(受 max_attempts 限制)"),
    next_step_id: z
      .string()
      .optional()
      .describe("成功后跳转到指定步骤(用于 agent 自主分支/循环);仅 status=success 时生效"),
  },
  async ({ run_id, step_id, output, status, next_step_id }) => {
    try {
      const { state, nextStep, nextSteps } = engine.reportResult(
        run_id, step_id, output, status ?? "success", next_step_id,
      );

      // 情况 1:run 已失败(重试耗尽)
      if (state.status === "failed") {
        const text = [
          `💥 步骤 ${step_id} 重试耗尽,工作流失败终止。`,
          ``,
          renderState(state),
          ``,
          `可用 rewind(run_id, to_step_id) 倒回到某一步重跑,或放弃这个 run。`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      }

      // 情况 2:run 已全部完成
      if (state.status === "completed" && nextStep === null) {
        const text = [
          `🎉 工作流全部完成!`,
          ``,
          renderState(state),
        ].join("\n");
        return { content: [{ type: "text", text }] };
      }

      // 情况 3:并行组内还有人(不推进新步)
      if (nextStep === null && state.activeStepIds && state.activeStepIds.length > 0) {
        const text = [
          `✓ ${step_id} 已完成。本组还有 ${state.activeStepIds.length} 步在跑:${state.activeStepIds.join(", ")}`,
          ``,
          renderState(state),
        ].join("\n");
        return { content: [{ type: "text", text }] };
      }

      // 情况 4:重试中(返回的 nextStep 就是刚报的那步,且 attempts>0 且仍 running)
      const justReported = engine.get(run_id)?.steps.find((s) => s.id === step_id);
      if (
        nextStep && justReported &&
        justReported.id === nextStep.id &&
        justReported.attempts > 0 &&
        justReported.status === "running"
      ) {
        const maxA = nextStep.max_attempts ?? 1;
        const text = [
          `⚠️ ${step_id} 报告失败,触发重试(第 ${justReported.attempts}/${maxA} 次)。请重新执行这一步。`,
          ``,
          renderState(state),
          ``,
          renderStepAction(nextStep, run_id),
        ].join("\n");
        return { content: [{ type: "text", text }] };
      }

      // 情况 5:正常推进(线性 / 组刚完成推进到新 front / goto)
      const head = nextSteps && nextSteps.length > 1
        ? `✓ ${step_id} 已完成,推进到并行组(${nextSteps.length} 步同时开始):${nextSteps.map((s) => s.id).join(", ")}`
        : `✓ ${step_id} 已完成,推进到下一步。`;
      const actionText = nextSteps && nextSteps.length > 1
        ? nextSteps.map((s) => renderStepAction(s, run_id)).join("\n\n")
        : renderStepAction(nextStep!, run_id);
      const text = [
        head,
        ``,
        renderState(state),
        ``,
        actionText,
      ].join("\n");
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `❌ 推进失败: ${(e as Error).message}`,
          },
        ],
      };
    }
  },
);

// ---- 工具 3: get_run_status ----
server.tool(
  "get_run_status",
  `查看某个工作流运行的当前状态。用于:确认现在该执行哪一步、断点恢复、调试。`,
  {
    run_id: z.string(),
  },
  async ({ run_id }) => {
    const state = engine.get(run_id);
    if (!state) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ run_id 不存在: ${run_id}` }],
      };
    }
    return { content: [{ type: "text", text: renderState(state) }] };
  },
);

// ---- 工具 4: list_runs(断点恢复的关键:看到哪些 run 没跑完) ----
server.tool(
  "list_runs",
  `列出所有工作流运行记录(含已完成和中断的)。用于:重启后找到没跑完的 run,接着跑。`,
  {
    only_incomplete: z
      .boolean()
      .optional()
      .describe("只列出未完成的 run(用于找断点恢复的对象)"),
  },
  async ({ only_incomplete }) => {
    let runs = engine.listRuns();
    if (only_incomplete) runs = runs.filter((r) => r.status === "running");
    if (runs.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: only_incomplete
              ? `没有中断中的 run。`
              : `没有任何 run 记录。`,
          },
        ],
      };
    }
    const lines = runs.map((r) => {
      const done = r.steps.filter((s) => s.status === "completed").length;
      const age = Math.round((Date.now() - r.startedAt) / 60000);
      const mark = r.status === "completed" ? "✅" : r.status === "failed" ? "❌" : "⏸️";
      return `${mark} ${r.runId} | ${r.workflowName} | ${done}/${r.steps.length}步 | ${r.status} | ${age}min前`;
    });
    const text = [
      `共 ${runs.length} 个 run${only_incomplete ? "(仅未完成)" : ""}:`,
      ``,
      ...lines,
      ``,
      `要恢复某个 run:用 get_run_status(run_id) 查看,再 report_step_result 接着推进。`,
    ].join("\n");
    return { content: [{ type: "text", text }] };
  },
);

// ---- 工具 5: rewind(倒带重跑:把某 run 回退到指定步重新开始) ----
server.tool(
  "rewind",
  `把一个工作流运行"倒带"到指定步骤,从那里重新开始执行。
该步骤及其之后的所有步骤都会被重置(状态→pending/running、output 清空、尝试次数清零)。
用途:修正某步的错误产出、重试一个已失败的 run、回到分叉点做不同选择。
注意:rewind 后并行组状态会被清空(回到线性游标语义),从目标步重新单步推进。`,
  {
    run_id: z.string().describe("要倒带的 run_id"),
    to_step_id: z.string().describe("要回退到的步骤 id(从这一步重新开始)"),
  },
  async ({ run_id, to_step_id }) => {
    try {
      const state = engine.rewind(run_id, to_step_id);
      const def = engine.getDef(run_id);
      const defStep = def?.steps.find((s) => s.id === to_step_id);
      const firstStep = defStep
        ? {
            id: defStep.id,
            description: defStep.description,
            instruction: defStep.instruction,
            skill: defStep.skill,
            args: defStep.args,
            group: defStep.group,
            max_attempts: defStep.max_attempts,
          }
        : null;
      const text = [
        `⏪ 已倒带到 ${to_step_id},从这里重新开始。`,
        ``,
        renderState(state),
        ...(firstStep ? ["", renderStepAction(firstStep, run_id)] : []),
      ].join("\n");
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `❌ 倒带失败: ${(e as Error).message}`,
          },
        ],
      };
    }
  },
);

// ---- 启动 ----
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 日志走 stderr,不污染 stdout(MCP 用 stdout 通信)
  console.error("[workflow-mcp] stateful server started on stdio");

  // 启动看板 HTTP+SSE(失败不能挂 MCP——MCP 是主功能,看板是附加)
  startWebServer(engine, WEB_PORT).catch((e) => {
    console.error("[workflow-mcp] 看板启动失败(不影响 MCP):", e);
  });
}

main().catch((e) => {
  console.error("[workflow-mcp] fatal:", e);
  process.exit(1);
});
