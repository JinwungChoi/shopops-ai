import type { AgentRoute } from "./agent-routing";

export type InquiryTool = Exclude<AgentRoute, { name: "finish" }>;
type Select = (observation?: unknown) => Promise<AgentRoute>;

// 도구 결과로 다음 결정을 내리며, 한 턴의 비용과 실행 횟수를 제한한다.
export async function runAgentLoop(select: Select, execute: (tool: InquiryTool) => Promise<unknown>) {
  const seen = new Map<string, unknown>();
  let observation: unknown;
  for (let step = 0; step < 4; step++) {
    let next: AgentRoute;
    try {
      next = await select(observation);
    } catch (error) {
      if (step === 0) throw error;
      return "incomplete";
    }
    if (next.name === "finish") return next.args.outcome;
    const key = JSON.stringify(next);
    if (seen.has(key)) {
      observation = { repeated: true, result: seen.get(key) };
    } else {
      try {
        observation = await execute(next);
      } catch (error) {
        if (seen.size === 0) throw error;
        return "incomplete";
      }
      seen.set(key, observation);
    }
  }
  return "incomplete";
}
