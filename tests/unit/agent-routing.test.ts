// 도구 선택기의 대화 메시지 조립을 가짜 모델로 검증한다. 실제 OpenAI는 호출하지 않는다.
import { beforeEach, expect, it, vi } from "vitest";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

vi.mock("server-only", () => ({}));

const replies: AIMessage[] = [];
const seen: BaseMessage[][] = [];
vi.mock("@langchain/openai", () => ({
  ChatOpenAI: class {
    bindTools() {
      return { invoke: async (messages: BaseMessage[]) => {
        seen.push([...messages]);
        const next = replies.shift();
        if (!next) throw new Error("가짜 모델 응답이 없습니다.");
        return next;
      } };
    }
  },
}));

const { createToolSelector } = await import("@/server/agent-routing");
const reply = (id: string, name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: "", tool_calls: [{ id, name, args, type: "tool_call" }] });

beforeEach(() => {
  replies.length = 0;
  seen.length = 0;
  vi.stubEnv("OPENAI_API_KEY", "test-only");
  vi.stubEnv("OPENAI_CHAT_MODEL", "test-model");
});

it("도구 없이 바로 끝내려 하면 한 번 되물어 도구를 다시 고르게 한다", async () => {
  replies.push(reply("c1", "finish", { outcome: "clarify" }),
    reply("c2", "prepare_return", { orderReference: null, productHint: "검증 셔츠", reason: "change_of_mind" }));
  const select = createToolSelector("검증 셔츠 반품할래요. 단순 변심", undefined, undefined, []);
  await expect(select()).resolves.toMatchObject({ name: "prepare_return" });
  expect(seen).toHaveLength(2);
  const recheck = seen[1].at(-1);
  expect(recheck).toBeInstanceOf(ToolMessage);
  expect((recheck as ToolMessage).tool_call_id).toBe("c1");
});

it("다시 물어도 finish를 고르면 그대로 끝내고 더 묻지 않는다", async () => {
  replies.push(reply("c1", "finish", { outcome: "answer" }), reply("c2", "finish", { outcome: "answer" }));
  const select = createToolSelector("안녕하세요", undefined, undefined, []);
  await expect(select()).resolves.toEqual({ name: "finish", args: { outcome: "answer" } });
  expect(seen).toHaveLength(2);
});

it("도구를 쓴 뒤의 finish는 되묻지 않는다", async () => {
  replies.push(reply("c1", "search_policies", { query: "반품비" }), reply("c2", "finish", { outcome: "answer" }));
  const select = createToolSelector("반품비 얼마예요?", undefined, undefined, []);
  await select();
  await expect(select({ answer: "6,000원" })).resolves.toMatchObject({ name: "finish" });
  expect(seen).toHaveLength(2);
  expect((seen[1].at(-1) as ToolMessage).content).toContain("6,000원");
});

it("되묻기에 모델이 도구 없이 문장으로 답하면 처음 고른 종료를 유지한다", async () => {
  replies.push(reply("c1", "finish", { outcome: "answer" }), new AIMessage({ content: "안녕하세요! 무엇을 도와드릴까요?" }));
  const select = createToolSelector("안녕하세요", undefined, undefined, []);
  await expect(select()).resolves.toEqual({ name: "finish", args: { outcome: "answer" } });
  expect(seen).toHaveLength(2);
});
