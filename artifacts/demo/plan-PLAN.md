# plan 步骤产出(PLAN · demo)

> 真实 gsd-plan-phase 会为某个 roadmap 阶段生成可执行 PLAN.md。此处是编排实验的轻量 demo 计划。

## 上游输入
- 来自 discuss-CONTEXT.md:目标是验证 workflow-sm 编排机制(步骤绑定 + 断点恢复),非功能开发。

## 演示执行计划
| 任务 | 动作 | 验收 |
|------|------|------|
| P1 绑定验证 | 确认 4 步各绑了真实 skill(discuss/plan/execute/review) | 每步 server 返回的 instruction 含 skill 名 |
| P2 推进机制 | 每步 report_step_result 后,progress 正确 +1 | 状态 0/4 → 1/4 → 2/4 → 3/4 → 4/4 |
| P3 上下文传递 | 上一步 output 能被下一步当作上下文读取 | plan 能引用 discuss 的结论 |
| P4 断点恢复(可选) | 关闭后 list_runs(only_incomplete=true) 能定位中断 run | get_run_status 显示应从哪步续 |

## 本步输出
- 已产出此 demo PLAN,execute 步据 P1–P4 "执行"(实为核对机制行为)。
- 已知约束:无真实代码可执行,故 execute/review 聚焦于机制核对而非代码改动。

## 下一步
- execute:按 P1–P3 实际推进工作流并记录机制行为。
