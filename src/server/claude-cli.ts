import "server-only";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemoError } from "./demo-core";

// 로컬 개발 전용 모델 어댑터: OpenAI API 대신 설치된 Claude Code CLI(`claude -p`)로 구조화 응답을 받는다.
// 왜 필요한가: 로컬 반복 검증에서 API 키 비용 없이 모델의 도구 선택·답변 생성을 확인하기 위해서다.
// 안전 장치: 내장 도구·MCP·설정·슬래시 명령을 모두 끄고, 빈 임시 폴더에서 실행하며, 고객 입력은 stdin으로만 넘긴다.
export function claudeCliEnabled() {
  if (process.env.SHOP_OPS_LLM !== "claude-cli") return false;
  if (process.env.NODE_ENV === "production") throw new DemoError(503, "로컬 개발용 모델 설정은 운영에서 사용할 수 없어요.");
  return true;
}

let workdir: string | undefined;

export async function claudeStructured(system: string, input: string, schema: object, timeoutMs = 60_000): Promise<unknown> {
  workdir ??= mkdtempSync(join(tmpdir(), "shopops-claude-"));
  const args = ["-p", "--model", process.env.SHOP_OPS_CLAUDE_MODEL || "haiku", "--tools", "", "--strict-mcp-config",
    "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json",
    "--system-prompt", system, "--json-schema", JSON.stringify(wrapped(schema)), "Answer for the JSON input on stdin."];
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("claude", args, { cwd: workdir, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => { child.kill(); reject(new DemoError(504, "로컬 모델 응답이 늦어요. 다시 시도해 주세요.")); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); reject(new DemoError(503, "로컬 Claude CLI를 실행하지 못했어요.")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else {
        // 로컬 개발 진단용. 고객 입력은 stdin으로만 보내므로 stderr에 섞이지 않는다.
        const brief = /"subtype":"[^"]*"|"result":"[^"]{0,200}|"api_error_status":[^,]*/g;
        console.error("[claude-cli] exit", code, stderr.slice(0, 200), (stdout.match(brief) ?? []).join(" "));
        reject(new DemoError(502, "로컬 모델 호출에 실패했어요."));
      }
    });
    child.stdin.end(input, "utf8");
  });
  let parsed: { is_error?: boolean; structured_output?: unknown };
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new DemoError(502, "로컬 모델 응답을 읽지 못했어요.");
  }
  if (parsed.is_error || parsed.structured_output === undefined) throw new DemoError(502, "로컬 모델 응답을 확인하지 못했어요.");
  const value = parsed.structured_output;
  return typeof value === "object" && value !== null && "value" in value ? value.value : undefined;
}

// CLI의 구조화 출력은 최상위가 object여야 하므로 anyOf 같은 스키마를 value 필드로 감싼다.
function wrapped(schema: object) {
  const inner: Record<string, unknown> = { ...schema };
  delete inner.$schema;
  return { type: "object", properties: { value: inner }, required: ["value"], additionalProperties: false };
}
