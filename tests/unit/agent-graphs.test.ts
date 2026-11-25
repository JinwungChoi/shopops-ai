import { writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// 그래프 구조 회귀 테스트. PRINT_GRAPHS=1이면 docs/AGENT_GRAPHS.md를 다시 만든다.
it("에이전트 루프와 접수 워크플로가 LangGraph 노드·간선으로 구성된다", async () => {
  const { agentLoopGraph } = await import("../../src/server/agent-loop");
  const { agentWorkflowGraph } = await import("../../src/server/agent-workflow");
  const loop = (await agentLoopGraph().getGraphAsync()).drawMermaid();
  const workflow = (await agentWorkflowGraph.getGraphAsync()).drawMermaid();
  if (process.env.PRINT_GRAPHS === "1") {
    const doc = [
      "# 에이전트 LangGraph 구조",
      "",
      "코드에서 생성한 그림이다. 다시 만들기: `PRINT_GRAPHS=1 npx vitest run tests/unit/agent-graphs.test.ts`",
      "",
      "## 한 턴의 도구 루프 (`src/server/agent-loop.ts`)",
      "",
      "decide: 모델이 다음 도구를 고른다. act: 서버가 도구를 실행한다. 한 턴 최대 5결정.",
      "",
      "```mermaid", loop.trim(), "```",
      "",
      "## 접수·주문 확인 워크플로 (`src/server/agent-workflow.ts`)",
      "",
      "locate: 주문 찾기. prepare: 확인 카드 초안. decide: 고객이 누른 버튼을 DB에서 처리.",
      "",
      "```mermaid", workflow.trim(), "```",
      "",
    ].join("\n");
    writeFileSync(new URL("../../docs/AGENT_GRAPHS.md", import.meta.url), doc);
  }
  expect(loop).toMatch(/decide/);
  expect(loop).toMatch(/act/);
  expect(workflow).toMatch(/locate/);
  expect(workflow).toMatch(/prepare/);
});
