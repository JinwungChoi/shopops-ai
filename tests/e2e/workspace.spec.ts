import { expect, test } from "@playwright/test";

test("Style Shop 반품 답변과 출처, FAQ 갱신과 보류", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "무엇을 도와드릴까요?" })).toBeVisible();
  const askReturns = () => page.getByRole("button", { name: "반품 기간" }).click();

  await askReturns();
  await expect(page.getByText("일반 반품 신청 기간이 지났어요.", { exact: false })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "답변 근거" })).toContainText("7일 이내");

  await expect(page.getByRole("combobox", { name: "쇼핑몰" })).toHaveCount(0);

  const knowledge = page.getByRole("button", { name: "지식베이스" });
  const chat = page.getByRole("button", { name: "상담 테스트" });
  await knowledge.click();
  await page.getByLabel("정책 본문").fill("상품 수령 후 21일 이내에 반품을 신청할 수 있습니다.");
  await page.getByRole("button", { name: "변경사항 저장" }).click();
  await expect(page.getByText("인덱싱 필요", { exact: true })).toBeVisible();
  await chat.click();
  await askReturns();
  await expect(page.getByText("일치하는 근거 없음")).toBeVisible();

  await knowledge.click();
  await page.getByRole("button", { name: "다시 인덱싱" }).click();
  await expect(page.getByText("검색 가능", { exact: true })).toBeVisible();
  await chat.click();
  await askReturns();
  await expect(page.getByRole("complementary", { name: "답변 근거" })).toContainText("21일 이내");
  await expect(page.getByRole("complementary", { name: "답변 근거" })).toContainText("v2");

  await page.getByRole("button", { name: "새 대화" }).click();
  await page.getByRole("textbox", { name: "질문" }).fill("할인 쿠폰 있나요?");
  await page.getByRole("button", { name: "질문 보내기" }).click();
  await expect(page.getByText("일치하는 근거 없음")).toBeVisible();
});

test("공개 데모는 Style Shop 링크에서만 상담을 시작한다", async ({ request }) => {
  expect((await request.get("/chat/demo-style-shop")).status()).toBe(200);
  expect((await request.get("/chat/demo-gadget-shop")).status()).toBe(404);
  const disabled = await request.post("/api/public/sessions", { data: { publicWidgetKey: "demo-gadget-shop" } });
  expect(disabled.status()).toBe(400);
});
test("모바일 공개 상담에서 출처를 펼쳐 볼 수 있다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/chat/demo-style-shop");
  await page.getByRole("button", { name: "반품 기간" }).click();
  await page.locator("summary").filter({ hasText: "반품 및 환불 정책" }).click();
  await expect(page.locator(".inline-source").getByText("상품 수령 후 7일 이내", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`상담 모션은 실제 요청 상태를 따르고 모션 설정을 존중한다 (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    const modelResponse = Promise.withResolvers<void>();

    await page.route("**/api/public/messages", async (route) => {
      await modelResponse.promise;
      await route.continue();
    });

    await page.goto("/");
    await page.getByRole("button", { name: "반품 기간" }).click();
    const animation = (name: string) => reducedMotion === "reduce" ? "none" : name;

    try {
      const pending = page.getByRole("status").filter({ hasText: "요청 확인 중" });
      await expect(pending).toBeVisible();
      await expect(pending).toHaveCSS("animation-name", animation("search-shimmer"));
      await expect(page.locator(".user-message")).toHaveCSS("animation-name", animation("question-in"));
    } finally {
      modelResponse.resolve();
    }

    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.locator(".assistant-answer")).toHaveCSS("animation-name", animation("answer-in"));
    await expect(page.locator(".source-card")).toHaveCSS("animation-name", animation("chat-in"));
    await page.locator(".inline-source summary").click();
    await expect(page.locator(".inline-source > p")).toBeVisible();
  });
}

test("빠른 응답도 검색 모션을 마친 뒤 첫 줄에 맞춰 표시한다", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/api/public/messages", (route) => route.fulfill({
    json: { answer: "반품은 수령 후 7일 이내에 신청할 수 있습니다. 상품 태그를 확인해 주세요.", abstained: false, sources: [] },
  }));
  await page.goto("/chat/demo-style-shop");
  await page.locator(".conversation").evaluate((conversation) => {
    let searchStarted: number | undefined;
    let searchFinished: number | undefined;
    const observer = new MutationObserver(() => {
      const loader = conversation.querySelector(".pending");
      if (loader) searchStarted ??= performance.now();
      if (loader?.hasAttribute("data-finishing")) searchFinished ??= performance.now();
      if (conversation.querySelector(".assistant-answer") && searchStarted !== undefined && searchFinished !== undefined) {
        conversation.setAttribute("data-search-duration", String(searchFinished - searchStarted));
        observer.disconnect();
      }
    });
    observer.observe(conversation, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-finishing"] });
  });
  await page.getByRole("button", { name: "반품 기간" }).click();
  await expect(page.locator(".assistant-answer")).toBeVisible();
  const duration = await page.locator(".conversation").getAttribute("data-search-duration");
  expect(Number(duration)).toBeGreaterThan(300);

  const offset = await page.locator(".assistant-message").evaluate((row) => {
    const icon = row.querySelector(".assistant-mark")!.getBoundingClientRect();
    const text = row.querySelector(".assistant-copy")!;
    const firstLineCenter = text.getBoundingClientRect().top + parseFloat(getComputedStyle(text).lineHeight) / 2;
    return icon.top + icon.height / 2 - firstLineCenter;
  });
  expect(offset).toBeCloseTo(0, 0);
});

test("신상 카드, 사이즈 후속 조건, 품절과 반품 정책을 한 대화에서 표시한다", async ({ page }) => {
  await page.goto("/chat/demo-style-shop");
  await page.getByRole("button", { name: "신상 재킷" }).click();
  let products = page.getByRole("list", { name: "추천 상품" }).last();
  await expect(products.getByRole("heading")).toHaveCount(2);
  await expect(products.getByText("M 품절")).toBeVisible();
  await expect.poll(() => products.locator("img").evaluateAll((images) =>
    images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0),
  )).toBe(true);

  const ask = async (question: string) => {
    await page.getByRole("textbox", { name: "질문" }).fill(question);
    await page.getByRole("button", { name: "질문 보내기" }).click();
  };
  await ask("M 사이즈만");
  await expect(page.getByRole("list", { name: "추천 상품" })).toHaveCount(2);
  products = page.getByRole("list", { name: "추천 상품" }).last();
  await expect(products.getByRole("heading", { name: "블랙 트윌 재킷" })).toBeVisible();
  await expect(products.getByRole("heading")).toHaveCount(1);

  await ask("받고 나서 반품은 며칠까지 돼?");
  await expect(page.locator(".turn").last()).toContainText("7일 이내");
  await expect(page.locator(".turn").last().locator(".inline-source")).toBeVisible();
  await ask("6만 원 미만 신상 재킷 보여줘");
  await expect(page.locator(".turn").last()).toContainText("조건에 맞는 상품이 없어요.");
});

test("서버가 전송한 작업 단계가 채팅에 표시되고 답변과 교체된다", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/api/public/messages", (route) => route.fulfill({
    contentType: "application/x-ndjson",
    body: [
      JSON.stringify({ type: "progress", stage: "routing" }),
      JSON.stringify({ type: "progress", stage: "track_shipment" }),
      JSON.stringify({ type: "answer", data: { answer: "군포 물류센터", sources: [], abstained: false } }),
    ].join("\n") + "\n",
  }));
  await page.goto("/chat/demo-style-shop");
  await page.getByRole("textbox", { name: "질문" }).fill("택배 어디까지 왔어요?");
  await page.getByRole("button", { name: "질문 보내기" }).click();
  await expect(page.getByRole("status").filter({ hasText: "택배 이동 기록 확인 중" })).toBeVisible();
  await expect(page.getByText("군포 물류센터", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
});
