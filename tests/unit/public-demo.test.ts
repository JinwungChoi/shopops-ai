// 공개 데모 안전장치: IP 제한 키는 Vercel이 넣는 헤더에서만 읽는다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
const { clientIp } = await import("@/server/demo-http");

const request = (headers: Record<string, string>) => new NextRequest("http://127.0.0.1/api/public/sessions", { headers });

describe("clientIp", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("Vercel 밖에서는 헤더를 믿지 않는다(로컬에서 위조한 헤더로 제한을 우회하거나 남을 막지 못하게)", () => {
    vi.stubEnv("VERCEL", "");
    expect(clientIp(request({ "x-forwarded-for": "203.0.113.7" }))).toBeNull();
  });

  it("Vercel에서는 x-real-ip, 없으면 x-forwarded-for의 첫 주소를 쓴다", () => {
    vi.stubEnv("VERCEL", "1");
    expect(clientIp(request({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }))).toBe("203.0.113.7");
    expect(clientIp(request({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }))).toBe("198.51.100.1");
    expect(clientIp(request({}))).toBeNull();
  });
});
