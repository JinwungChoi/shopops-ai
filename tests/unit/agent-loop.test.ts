import { expect, it, vi } from "vitest";
import { runAgentLoop } from "../../src/server/agent-loop";
import type { AgentRoute } from "../../src/server/agent-routing";

it("주문 조회 결과를 모델에 전달하고 모델이 선택한 정책 도구를 실행한다", async () => {
  const eligibility = { name: "list_returnable_orders", args: {
    scope: "previous_orders", orderReference: null, productHint: null,
  } } as const;
  const policy = { name: "search_policies", args: { query: "반품비" } } as const;
  const select = vi.fn<() => Promise<AgentRoute>>()
    .mockResolvedValueOnce(eligibility).mockResolvedValueOnce(policy)
    .mockResolvedValueOnce({ name: "finish", args: { outcome: "answer" } });
  const execute = vi.fn().mockResolvedValueOnce({ eligibleOrders: ["STY-1003"] }).mockResolvedValueOnce({ fee: 6000 });
  await expect(runAgentLoop(select, execute)).resolves.toBe("answer");
  expect(select.mock.calls).toEqual([[undefined], [{ eligibleOrders: ["STY-1003"] }], [{ fee: 6000 }]]);
  expect(execute.mock.calls).toEqual([[eligibility], [policy]]);
});

it("반복된 도구를 다시 실행하지 않고 네 결정에서 종료한다", async () => {
  const select = vi.fn<() => Promise<AgentRoute>>().mockResolvedValue({ name: "list_orders", args: { status: null } });
  const execute = vi.fn().mockResolvedValue({ orders: [] });
  await expect(runAgentLoop(select, execute)).resolves.toBe("incomplete");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(select).toHaveBeenCalledTimes(4);
});
