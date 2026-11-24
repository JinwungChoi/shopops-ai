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

it("반복된 도구를 다시 실행하지 않고 다섯 결정에서 종료한다", async () => {
  const select = vi.fn<() => Promise<AgentRoute>>().mockResolvedValue({ name: "list_orders", args: { status: null } });
  const execute = vi.fn().mockResolvedValue({ orders: [] });
  await expect(runAgentLoop(select, execute)).resolves.toBe("incomplete");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(select).toHaveBeenCalledTimes(5);
});

it("첫 결정의 오류는 원래 오류 그대로 올리고, 이후 오류는 지금까지 결과로 마무리한다", async () => {
  class RouteError extends Error {}
  const failing = vi.fn<() => Promise<AgentRoute>>().mockRejectedValue(new RouteError("route"));
  await expect(runAgentLoop(failing, vi.fn())).rejects.toBeInstanceOf(RouteError);

  const later = vi.fn<() => Promise<AgentRoute>>()
    .mockResolvedValueOnce({ name: "view_cart", args: {} }).mockRejectedValueOnce(new RouteError("route"));
  await expect(runAgentLoop(later, vi.fn().mockResolvedValue({ cart: [] }))).resolves.toBe("incomplete");
});

it("첫 도구 실행 오류는 그대로 올린다", async () => {
  class ToolError extends Error {}
  const select = vi.fn<() => Promise<AgentRoute>>().mockResolvedValue({ name: "view_cart", args: {} });
  await expect(runAgentLoop(select, vi.fn().mockRejectedValue(new ToolError("tool")))).rejects.toBeInstanceOf(ToolError);
});
