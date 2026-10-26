// engine.ts — 纯状态机逻辑,不依赖 MCP。可单独测试。
// 这是实验的核心:验证"有状态推进"这个机制本身成不成立。

import yaml from "js-yaml";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---- 类型定义 ----

export interface WorkflowStep {
  id: string;
  description: string;
  /** 这一步期望 agent 做什么(自然语言指令) */
  instruction: string;
  /** 可选:绑定一个 Claude Code skill,server 会提示 agent 调用 /skill */
  skill?: string;
  /** 可选:传给 skill 的参数 */
  args?: string;
  /** 可选:把连续的同 group 步骤激活为一个并行 front(同组成员同时 running) */
  group?: string;
  /** 可选:失败时的最大尝试次数(含首次),默认 1 = 不重试 */
  max_attempts?: number;
}

export interface WorkflowDef {
  name: string;
  description: string;
  steps: WorkflowStep[];
}

export type StepStatus = "pending" | "running" | "completed" | "failed";
export type RunStatus = "running" | "completed" | "failed";

export interface StepState {
  id: string;
  status: StepStatus;
  output: string | null;
  startedAt: number | null;
  completedAt: number | null;
  /** 已尝试次数(成功 / 未跑都从 0 起)。失败后递增,直到 max_attempts。默认 0,兼容旧落盘。 */
  attempts: number;
}

export interface RunState {
  runId: string;
  workflowName: string;
  status: RunStatus;
  steps: StepState[];
  currentIndex: number; // 当前 front 的起点索引(线性模式 = 当前步;并行模式 = 当前组起点)
  startedAt: number;
  updatedAt: number;
  /** 用于可移植性观察:记录每次工具调用的顺序 */
  callLog: string[];
  /** 当前并行 front 里仍在跑的 step id 列表。undefined / 空 = 线性单游标(旧行为)。 */
  activeStepIds?: string[];
}

// ---- 解析 + 校验 ----

export function parseWorkflow(yamlText: string): WorkflowDef {
  const obj = yaml.load(yamlText);
  if (typeof obj !== "object" || obj === null) {
    throw new Error("YAML 顶层必须是对象");
  }
  const def = obj as Record<string, unknown>;
  if (typeof def.name !== "string") throw new Error("workflow 缺少 name");
  if (!Array.isArray(def.steps)) throw new Error("workflow 缺少 steps 数组");
  if (def.steps.length === 0) throw new Error("steps 不能为空");

  const steps: WorkflowStep[] = def.steps.map((s, i) => {
    const step = s as Record<string, unknown>;
    if (typeof step.id !== "string") throw new Error(`step[${i}] 缺少 id`);
    const maxAttempts = step.max_attempts;
    if (maxAttempts !== undefined) {
      // 必须是正整数
      if (typeof maxAttempts !== "number" || !Number.isFinite(maxAttempts) ||
          maxAttempts < 1 || !Number.isInteger(maxAttempts)) {
        throw new Error(`step[${i}](${step.id}) 的 max_attempts 必须是 ≥1 的整数`);
      }
    }
    return {
      id: step.id,
      description: String(step.description ?? ""),
      instruction: String(step.instruction ?? step.description ?? ""),
      skill: typeof step.skill === "string" ? step.skill : undefined,
      args: typeof step.args === "string" ? step.args : undefined,
      group: typeof step.group === "string" ? step.group : undefined,
      max_attempts: maxAttempts,
    };
  });

  // 检查 id 唯一
  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.id)) throw new Error(`step id 重复: ${s.id}`);
    ids.add(s.id);
  }

  return { name: def.name, description: String(def.description ?? ""), steps };
}

// ---- 状态机 ----

export class WorkflowEngine {
  private runs = new Map<string, RunState>();
  // 存住原始 workflow 定义,以便返回 nextStep 时带上 instruction
  private defs = new Map<string, WorkflowDef>();
  /** 持久化目录;为 undefined 时不落盘(纯内存模式,兼容旧测试) */
  private storeDir: string | undefined;

  constructor(storeDir?: string) {
    this.storeDir = storeDir;
  }

  /** 启动时调用:从磁盘恢复所有历史 run。这就是断点恢复的核心。 */
  loadAll(): void {
    if (!this.storeDir || !existsSync(this.storeDir)) return;
    for (const file of readdirSync(this.storeDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(this.storeDir, file), "utf8");
        const doc = JSON.parse(raw) as { state: RunState; def: WorkflowDef };
        // 回填历史落盘文件缺失的新字段(向后兼容)
        for (const s of doc.state.steps) {
          if (s.attempts === undefined) s.attempts = 0;
        }
        if (doc.state.activeStepIds === undefined) doc.state.activeStepIds = undefined;
        this.runs.set(doc.state.runId, doc.state);
        this.defs.set(doc.state.runId, doc.def);
      } catch {
        // 单个文件损坏不影响其他 run
      }
    }
  }

  /** 查看器模式:重新从磁盘加载全部 run,同步其他实例写入的最新状态(含新增与删除)。 */
  reloadFromDisk(): void {
    if (!this.storeDir || !existsSync(this.storeDir)) return;
    this.runs.clear();
    this.defs.clear();
    this.loadAll();
  }

  /** 列出所有 run 的摘要(用于 list_runs 工具) */
  listRuns(): RunState[] {
    return Array.from(this.runs.values()).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }

  /** 状态变更回调(实时看板订阅;默认 undefined,不影响任何现有逻辑) */
  private onChange?: (runId: string) => void;

  /** 订阅状态变更(每次 start/reportResult/rewind 后触发)。用于实时看板 SSE。 */
  setOnChange(cb: ((runId: string) => void) | undefined): void {
    this.onChange = cb;
  }

  /** 通知外部观察者某 run 变了(无论是否落盘,内存模式也触发)。 */
  private notifyChange(runId: string): void {
    this.onChange?.(runId);
  }

  /** 把单个 run + 它的 def 落盘,并通知观察者(实时看板用)。 */
  private save(runId: string): void {
    // 无论是否落盘,先通知观察者(内存模式也触发,供实时看板)
    this.notifyChange(runId);
    if (!this.storeDir) return;
    const state = this.runs.get(runId);
    const def = this.defs.get(runId);
    if (!state || !def) return;
    if (!existsSync(this.storeDir)) mkdirSync(this.storeDir, { recursive: true });
    writeFileSync(
      join(this.storeDir, `${runId}.json`),
      JSON.stringify({ state, def }, null, 2),
      "utf8",
    );
  }

  start(workflow: WorkflowDef): RunState {
    const runId = genId();
    const now = Date.now();
    const state: RunState = {
      runId,
      workflowName: workflow.name,
      status: "running",
      steps: workflow.steps.map((s, i) => ({
        id: s.id,
        status: i === 0 ? "running" : "pending",
        output: null,
        startedAt: i === 0 ? now : null,
        completedAt: null,
        attempts: 0,
      })),
      currentIndex: 0,
      startedAt: now,
      updatedAt: now,
      callLog: [`start_workflow`],
    };
    this.runs.set(runId, state);
    this.defs.set(runId, workflow);
    // 首步若属于并行组,激活整个组(否则保持线性单游标,start 已设好 step[0])
    if (workflow.steps[0].group) {
      this.activateFront(state, 0);
    }
    this.save(runId);
    return state;
  }

  /** 取某 run 的 workflow 定义(用于查 step 的 instruction/description) */
  getDef(runId: string): WorkflowDef | undefined {
    return this.defs.get(runId);
  }

  get(runId: string): RunState | undefined {
    return this.runs.get(runId);
  }

  /**
   * 当前活跃的 step id 集合(用于 GUARD 判断"哪些步可以报告")。
   * - 线性模式(activeStepIds 为空/不存在):仅当前游标那一步。
   * - 并行模式(activeStepIds 非空):当前 front 里所有还在跑的步。
   */
  private activeSet(state: RunState): string[] {
    if (state.activeStepIds && state.activeStepIds.length > 0) {
      return state.activeStepIds;
    }
    return [state.steps[state.currentIndex].id];
  }

  /** 给某步从 def 补全完整字段(含 skill/args/group/max_attempts)。 */
  private stepDef(runId: string, stepId: string): WorkflowStep | undefined {
    const def = this.defs.get(runId);
    return def?.steps.find((s) => s.id === stepId);
  }

  /**
   * 激活从 fromIdx 起的下一个 front。
   * - 若该步有 group:把连续同 group 的步都置为 running,写入 activeStepIds。
   * - 否则:仅该步 running(线性单步),清空 activeStepIds。
   * 返回:该 front 里所有"被激活的 step id"(供渲染层用)。
   * 注:fromIdx 越界时返回空数组(表示流程结束),不修改 state。
   */
  private activateFront(state: RunState, fromIdx: number): string[] {
    const def = this.defs.get(state.runId);
    if (fromIdx >= state.steps.length || !def) return [];
    state.currentIndex = fromIdx;
    const firstDef = def.steps[fromIdx];
    const now = Date.now();
    if (!firstDef.group) {
      // 单步 front:回到线性游标语义
      state.activeStepIds = undefined;
      const step = state.steps[fromIdx];
      step.status = "running";
      step.startedAt = now;
      return [step.id];
    }
    // 组 front:收集连续同 group 的步,全部置 running
    const group = firstDef.group;
    const ids: string[] = [];
    for (let i = fromIdx; i < state.steps.length; i++) {
      if (def.steps[i].group !== group) break;
      const step = state.steps[i];
      step.status = "running";
      step.startedAt = now;
      ids.push(step.id);
    }
    state.activeStepIds = ids;
    return ids;
  }

  /**
   * 报告某一步的结果,推进状态机。
   * 守卫:只能报告"当前活跃集"里的步骤(线性模式=当前步;并行模式=组内活跃步)。
   * 新增能力(全可选,默认=旧行为):
   *   - status="failure":触发重试;耗尽 max_attempts 则该步 failed、run failed。
   *   - next_step_id:agent 显式跳转(向前推进 / 向后回退 / 循环重做)。仅 success 时生效。
   * 返回:
   *   - nextStep: 永远是"下一步指令"(线性兼容,并行模式返回首个活跃步或 null)。
   *   - nextSteps?: 本批新激活的步(并行模式可能多个;线性模式恒为 undefined)。
   */
  reportResult(
    runId: string,
    stepId: string,
    output: string,
    status: "success" | "failure" = "success",
    next_step_id?: string,
  ): {
    state: RunState;
    nextStep: WorkflowStep | null;
    nextSteps?: WorkflowStep[];
  } {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`run_id 不存在: ${runId}`);
    if (state.status !== "running")
      throw new Error(`run 已结束(status=${state.status}),不能继续报告`);

    const active = this.activeSet(state);
    state.callLog.push(`report_step_result(step=${stepId}, status=${status}${next_step_id ? `, goto=${next_step_id}` : ""})`);

    // ★ 泛化守卫:只能报告活跃集里的步骤(线性模式退化为"只能报当前步")
    if (!active.includes(stepId)) {
      throw new Error(
        `顺序错误:当前可报告步骤为 [${active.join(", ")}],但你报告了 "${stepId}"。` +
          `状态机要求严格按顺序推进。`,
      );
    }

    const now = Date.now();
    const currentStep = state.steps.find((s) => s.id === stepId)!;
    const currentDef = this.stepDef(runId, stepId);
    const maxAttempts = currentDef?.max_attempts ?? 1;

    // ---- 分支 A:失败报告 → 重试或耗尽 ----
    if (status === "failure") {
      currentStep.attempts += 1;
      currentStep.output = output; // 失败产出也记录,供重试参考
      state.updatedAt = now;
      if (currentStep.attempts < maxAttempts) {
        // 还能重试:保持 running,返回"自己"作为下一步(提示重跑)
        this.save(runId);
        const retryStep = this.toWorkflowStep(runId, stepId);
        return {
          state,
          nextStep: retryStep ?? null,
          nextSteps: retryStep ? [retryStep] : [],
        };
      }
      // 耗尽:该步 failed → run failed
      currentStep.status = "failed";
      currentStep.completedAt = now;
      state.status = "failed";
      this.save(runId);
      return { state, nextStep: null };
    }

    // ---- 成功:完成该步 ----
    currentStep.status = "completed";
    currentStep.output = output;
    currentStep.completedAt = now;
    state.updatedAt = now;

    // 把该步从活跃集移除(并行模式下可能还有兄弟在跑)
    if (state.activeStepIds && state.activeStepIds.length > 0) {
      state.activeStepIds = state.activeStepIds.filter((id) => id !== stepId);
    }

    // ---- 分支 B:agent 显式 goto(仅 success)----
    if (next_step_id) {
      const targetIdx = state.steps.findIndex((s) => s.id === next_step_id);
      if (targetIdx < 0) throw new Error(`goto 目标步骤不存在: ${next_step_id}`);
      const activated = this.activateFront(state, targetIdx);
      // 目标若是已完成步,重置为 running(由 activateFront 处理);清它的产出/完成标记
      for (const id of activated) {
        const st = state.steps.find((s) => s.id === id)!;
        st.output = null;
        st.completedAt = null;
        st.attempts = 0;
      }
      this.save(runId);
      const nextSteps = activated
        .map((id) => this.toWorkflowStep(runId, id))
        .filter(Boolean) as WorkflowStep[];
      return {
        state,
        nextStep: nextSteps[0] ?? null,
        nextSteps,
      };
    }

    // ---- 分支 C:并行组里还有兄弟没跑完 → 停在组内 ----
    if (state.activeStepIds && state.activeStepIds.length > 0) {
      this.save(runId);
      return {
        state,
        nextStep: null, // 组内还有人,不推进到新步
      };
    }

    // ---- 分支 D:线性 / 组刚空 → 推进到下一个 front ----
    // 计算下一个 front 的起点:
    //   线性模式:currentIndex + 1
    //   并行模式(组刚空):跳过整个刚完成的组,到组末 + 1
    const def = this.defs.get(runId)!;
    let nextFromIdx = state.currentIndex;
    if (currentDef?.group) {
      // 跳过刚完成的整组
      while (nextFromIdx < state.steps.length &&
             def.steps[nextFromIdx].group === currentDef.group) {
        nextFromIdx++;
      }
    } else {
      nextFromIdx = state.currentIndex + 1;
    }

    const activated = this.activateFront(state, nextFromIdx);
    if (activated.length === 0) {
      // 没有更多步:流程结束
      state.status = "completed";
      state.activeStepIds = undefined;
      this.save(runId);
      return { state, nextStep: null };
    }
    this.save(runId);
    const nextSteps = activated
      .map((id) => this.toWorkflowStep(runId, id))
      .filter(Boolean) as WorkflowStep[];
    return {
      state,
      nextStep: nextSteps[0] ?? null,
      nextSteps,
    };
  }

  /** 从原始 def 取某步,构造完整 WorkflowStep(含所有字段)。 */
  private toWorkflowStep(runId: string, stepId: string): WorkflowStep | undefined {
    const d = this.stepDef(runId, stepId);
    if (!d) return undefined;
    return {
      id: d.id,
      description: d.description,
      instruction: d.instruction,
      skill: d.skill,
      args: d.args,
      group: d.group,
      max_attempts: d.max_attempts,
    };
  }

  /**
   * 断点恢复测试:把一个 run "倒带"到某一步重新跑。
   * 这是赌注1(确定性/可恢复)的核心演示能力。
   */
  rewind(runId: string, toStepId: string): RunState {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`run_id 不存在: ${runId}`);
    const idx = state.steps.findIndex((s) => s.id === toStepId);
    if (idx < 0) throw new Error(`步骤不存在: ${toStepId}`);
    state.callLog.push(`rewind(to=${toStepId})`);
    // 归一化目标之前的步:上次 rewind 遗留的 "running"(被跳过)标为 completed,
    // 否则连续 rewind(先回 a 再回 b)会留下永久 running 的僵尸步
    for (let i = 0; i < idx; i++) {
      if (state.steps[i].status === "running") {
        state.steps[i].status = "completed";
        if (state.steps[i].completedAt === null) state.steps[i].completedAt = Date.now();
      }
    }
    // 先把 idx 及之后的步全部清空(状态、产出、时间、尝试次数)
    for (let i = idx; i < state.steps.length; i++) {
      state.steps[i].status = "pending";
      state.steps[i].output = null;
      state.steps[i].startedAt = null;
      state.steps[i].completedAt = null;
      state.steps[i].attempts = 0; // 重跑清零尝试次数
    }
    state.currentIndex = idx;
    state.status = "running";
    state.updatedAt = Date.now();
    // 用 activateFront 重新激活目标步的 front:
    //   目标属于并行组 → 整组重新 running + 写 activeStepIds
    //   目标是单步 → 仅该步 running,activeStepIds 清空(线性游标)
    this.activateFront(state, idx);
    this.save(runId);
    return state;
  }

  /** 删除一个 run:内存 + 磁盘状态文件。不存在时 throw。 */
  delete(runId: string): void {
    if (!this.runs.has(runId)) throw new Error(`run_id 不存在: ${runId}`);
    this.runs.delete(runId);
    this.defs.delete(runId);
    if (this.storeDir) {
      const file = join(this.storeDir, `${runId}.json`);
      try {
        if (existsSync(file)) rmSync(file);
      } catch {
        // 磁盘删除失败不阻塞(内存已删;文件残留会在下次 loadAll 复活,但极少发生)
      }
    }
  }
}

function genId(): string {
  return "run_" + Math.random().toString(36).slice(2, 10);
}
