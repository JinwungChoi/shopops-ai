import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { traceable } from "langsmith/traceable";
import type { AgentRoute } from "./agent-routing";

export type InquiryTool = Exclude<AgentRoute, { name: "finish" }>;
type Select = (observation?: unknown) => Promise<AgentRoute>;
type Execute = (tool: InquiryTool) => Promise<unknown>;
export type LoopOutcome = "answer" | "clarify" | "incomplete";

// 한 턴의 상담 에이전트 루프: decide(모델이 다음 도구 선택) → act(서버가 도구 실행) → decide … → 종료.
// 모델은 도구 이름과 인자만 고른다. 실행·권한·업무 판정은 execute 안의 서버 코드와 DB가 맡는다.
const maxDecisions = 5;

const LoopState = Annotation.Root({
  step: Annotation<number>(),
  observation: Annotation<unknown>(),
  next: Annotation<InquiryTool | undefined>(),
  // 같은 도구·인자 호출은 다시 실행하지 않고 이전 결과를 돌려준다.
  seen: Annotation<Record<string, unknown>>(),
  outcome: Annotation<LoopOutcome | undefined>(),
});
type State = typeof LoopState.State;

function buildLoop(select: Select, execute: Execute) {
  const decide = async ({ step, observation }: State): Promise<Partial<State>> => {
    let route: AgentRoute;
    try {
      route = await select(observation);
    } catch (error) {
      // 첫 결정이 실패하면 상위에서 오류로 처리하고, 이후 실패는 지금까지의 결과로 마무리한다.
      if (step === 0) throw error;
      return { outcome: "incomplete" };
    }
    if (route.name === "finish") return { outcome: route.args.outcome };
    return { next: route };
  };

  const act = async ({ step, next, seen }: State): Promise<Partial<State>> => {
    if (!next) return { outcome: "incomplete" };
    const key = JSON.stringify(next);
    let observation: unknown;
    let recorded = seen;
    if (key in seen) {
      observation = { repeated: true, result: seen[key] };
    } else {
      try {
        // LangSmith에 도구 실행 단계(run_type tool)로 기록한다. 추적이 꺼져 있으면 그대로 실행만 한다.
        observation = await traceable((tool: InquiryTool) => execute(tool), { name: next.name, run_type: "tool" })(next);
      } catch (error) {
        if (Object.keys(seen).length === 0) throw error;
        return { outcome: "incomplete" };
      }
      recorded = { ...seen, [key]: observation };
    }
    const nextStep = step + 1;
    return { step: nextStep, observation, seen: recorded, next: undefined,
      ...(nextStep >= maxDecisions && { outcome: "incomplete" as const }) };
  };

  return new StateGraph(LoopState)
    .addNode("decide", decide)
    .addNode("act", act)
    .addEdge(START, "decide")
    .addConditionalEdges("decide", (state) => state.outcome ? END : "act", ["act", END])
    .addConditionalEdges("act", (state) => state.outcome ? END : "decide", ["decide", END])
    .compile();
}

// 구조 확인용(문서·다이어그램). 실제 실행은 runAgentLoop가 요청마다 만든다.
export const agentLoopGraph = () => buildLoop(async () => ({ name: "finish", args: { outcome: "answer" } }), async () => null);

export async function runAgentLoop(select: Select, execute: Execute): Promise<LoopOutcome> {
  const output = await buildLoop(select, execute).invoke(
    { step: 0, observation: undefined, next: undefined, seen: {}, outcome: undefined },
    { recursionLimit: maxDecisions * 2 + 2 },
  );
  return output.outcome ?? "incomplete";
}
