# ShopOps AI 인수인계

2026-11-24 기준. 작업 규칙은 [AGENTS.md](../AGENTS.md), 제품 범위는 [PRD](PRD.md), 실행 흐름은 [아키텍처](ARCHITECTURE.md)와 [AI 설계](AI_DESIGN.md), 작업 ID는 [구현 계획](IMPLEMENTATION_PLAN.md)을 기준으로 한다.

## 현재 동작 범위

| 기능 | 로컬 구현 |
| --- | --- |
| 관리자와 RAG | Supabase Auth, 업체별 RLS, FAQ 등록·수정·인덱싱, pgvector 검색, 출처 검증과 근거 부족 응답 |
| Style Shop 고객 채팅 | 실제 작업 단계의 NDJSON 스트리밍, 상품 추천·재고, 고객 로그인, 최대 20건의 최근 모의 주문, 마지막 택배 스캔 |
| 에이전트 | 모델이 조회 결과를 받고 다음 도구 또는 종료를 선택. 한 턴에 최대 네 번 결정. `그중`은 앞에서 제시한 동일 세션의 주문 범위를 사용 |
| 반품·상담 | 가능한 주문 목록, 개별 주문의 판정·사유, 고객 확인 후 모의 반품 접수, 상담 문의 접수와 관리자 조회 |

Style Shop 한 곳으로 시연한다. 기본 합성 주문은 고객 A 12건과 고객 B 8건이다. RAG 평가와 접근 제어 테스트에는 두 업체의 분리된 데이터를 사용한다. 실제 결제·환불·택배 연동과 OCR/Vision은 범위 밖이다.

## 소스 지도와 유지할 동작

| 경로 | 역할 |
| --- | --- |
| [live-chat.ts](../src/server/live-chat.ts) | 세션 토큰과 고객 인증 확인, 대화 및 상태 저장, 요청 재전송 처리, 정책 출처의 활성 버전 확인 |
| [agent-routing.ts](../src/server/agent-routing.ts), [agent-loop.ts](../src/server/agent-loop.ts), [agent-inquiry.ts](../src/server/agent-inquiry.ts) | Zod 도구 입력 검증, LangGraph `decide`→`act` 반복 실행(최대 5결정, 같은 호출 재사용), 주문·정책·장바구니 결과 합성 |
| [mock-orders.ts](../src/server/mock-orders.ts), [agent-workflow.ts](../src/server/agent-workflow.ts) | 고객 범위의 주문 조회와 반품 판정, LangGraph로 접수 초안 생성과 고객 확인 처리 |
| [정책 검색](../src/server/policy-search.ts), [답변 생성](../src/server/generation.ts) | 업체 범위의 근거 검색, 정책 응답 생성과 출처 검증 |
| [workspace.tsx](../src/components/workspace.tsx), [live-admin.tsx](../src/components/live-admin.tsx) | 공개 채팅, 상품·주문 카드, 접수 확인, 관리자 문의 목록과 대화 조회 |
| [Agent 접수 마이그레이션](../supabase/migrations/20261123000900_agent_actions.sql), [주문 문맥 마이그레이션](../supabase/migrations/20261124000100_contextual_return_eligibility.sql) | 반품 판정, 승인 만료, FK/RLS, 중복 접수 방지, 이전에 표시한 주문 범위 조회 |

- `list_returnable_orders`는 신청 가능한 주문만 반환한다. 건수와 카드 모두 이 결과를 사용한다. `check_order_return_status`는 특정 주문의 판정·사유 또는 명시적으로 요청한 전체 판정을 조회한다.
- 주문, 업체 및 고객 권한은 서버가 바인딩한다. 모델에는 필요한 합성 주문 정보만 전달하고 인증 토큰·승인 ID·시크릿은 전달하지 않는다.
- 조회와 접수 의도는 모델이 파악한다. 실제 쓰기는 고객 확인 요청으로만 들어오며 DB가 소유권, 현재 상태, 승인 만료를 확인한다. 같은 승인의 재시도는 기존 접수번호를 반환한다.
- LangGraph는 두 곳에 쓴다: 한 턴의 도구 선택·실행 루프(`agent-loop.ts`)와 접수·주문 확인 단계(`agent-workflow.ts`). 재개 상태는 Supabase의 채팅 응답에 저장하며, Style Shop의 유효한 상담 세션은 같은 브라우저 탭에서 새로고침 후 이어진다.

## 다시 실행하기

Node.js 24, PowerShell 7, Docker, Supabase CLI가 필요하다. Windows에서 `supabase start`가 54321~54323 포트 bind 오류로 실패하면 `netsh int ipv4 show excludedportrange protocol=tcp`로 예약 범위를 확인하고, 관리자 PowerShell에서 `net stop winnat; net start winnat` 실행 후 다시 시작한다. 빠른 화면 데모는 `npm ci` 후 `npm run dev`로 시작하고 [포트 3000](http://127.0.0.1:3000)에서 확인한다. 이 경로는 키 없이 동작하는 메모리 데모다.

실제 모델과 주문·반품 흐름을 보려면 아래 순서로 시작한다. `.env.local`의 `OPENAI_API_KEY`는 로컬 환경 파일로 관리한다. Supabase 로컬 접속 설정은 PowerShell 스크립트가 주입한다.

```powershell
npm ci
supabase start
supabase migration up --local
pwsh -NoProfile -File scripts/test-local-supabase.ps1 -LiveModel -Serve
```

기존 DB에 Style Shop이 있으면 [공개 채팅](http://127.0.0.1:3031/chat/202dbac4609c4aaa9a7cd4ea0aa604a5)을 열고 [데모 계정과 질문](../demo/README.md#주문-조회와-반품-접수-시연)을 사용한다. 정책을 다시 넣거나 모의 주문을 갱신할 때는 다른 터미널에서 아래 명령을 실행한다.

```powershell
pwsh -NoProfile -File scripts/seed-showcase.ps1
pwsh -NoProfile -File scripts/seed-mock-orders.ps1
```

새 로컬 DB라면 [관리자 화면](http://127.0.0.1:3031)에서 개발용 관리자 계정을 만들고 쇼핑몰 이름 `Style Shop`, 슬러그 `live-style-local`로 생성한다. 시드가 고정 위젯 키를 찾으므로, 해당 키를 쓰는 업체가 아직 없을 때 새로 만든 로컬 업체에 아래와 같이 지정한 뒤 시드 두 개를 실행한다.

```powershell
$local = supabase status -o json 2>$null | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $local.DB_URL -notmatch '^postgresql://[^@]+@(127\.0\.0\.1|localhost):\d+/') {
    throw '로컬 Supabase DB가 필요합니다.'
}
@'
update public.tenants
set public_widget_key = '202dbac4609c4aaa9a7cd4ea0aa604a5'
where slug = 'live-style-local' and name = 'Style Shop' and is_active
  and not exists (
    select 1 from public.tenants where public_widget_key = '202dbac4609c4aaa9a7cd4ea0aa604a5'
  )
returning slug, public_widget_key;
'@ | psql $local.DB_URL -v ON_ERROR_STOP=1
```

반품 기한은 실제 시계 기준이다. 오래된 시드나 이미 접수된 주문으로 시연이 막히면 `pwsh -NoProfile -File scripts/seed-mock-orders.ps1 -FreshReturn`을 실행하고 고객 B와 출력된 새 주문번호를 사용한다.

## 검증

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
supabase test db
npx playwright install chromium --only-shell
$env:SHOP_OPS_TEST_AGENT = '1'
$env:SHOP_OPS_REUSE_TEST_SERVER = '1'  # 3031에서 실제 모델 서버를 이미 띄웠을 때만
pwsh -NoProfile -File scripts/test-local-supabase.ps1 -LiveModel
```

마지막 명령은 실제 OpenAI API를 호출한다. 이미 실행 중인 서버를 재사용할 때는 `-LiveModel -Serve`로 띄운 3031 서버인지 확인한다. 서버 없이 실행할 때는 재사용 변수를 생략한다. 키 없이 DB 통합을 검증하려면 3031이 비어 있을 때 같은 스크립트를 `-LiveModel` 없이 실행한다.

2026-11-24 변경 기준으로 단위 16건, DB 48건, 실제 모델 브라우저 3건 및 lint·typecheck·build를 통과했다. 이후 P2-07 1단계 다중 턴 단위 회귀 8건을 추가했고, 변경 후 단위 24건, 키 없는 메모리 데모 브라우저 8건, lint·typecheck·build를 통과했다. WinNAT 재시작으로 포트 예약을 푼 뒤 DB 48건도 다시 통과했다.

같은 날 실제 모델 브라우저 테스트를 다시 돌렸을 때 `반품 접수 승인` 테스트가 3회 중 2회 실패했다. 실패한 단계는 "방금 보여준 주문 중 반품 가능한 재킷 반품해줘. 반품비도 알려줘."에서 반품비 출처를 확인하는 부분이다. 원인은 두 가지였다.
- 확인된 원인: 모델이 `search_policies` 검색어를 영어 문장에 주문번호를 붙여 만들었다. 이 검색어에서 반품비 문서의 거리는 0.666으로 기준 0.65를 넘었다. 같은 내용을 `단순 변심 반품비`로 쓰면 0.509로 기준 안에 든다. 주문번호만 빼면 0.654로 여전히 기준을 넘으므로 서버에서 주문번호를 지우는 방식은 해결책이 아니다. 도구 설명을 고객 언어의 짧은 정책 주제로 쓰고 주문번호와 상품명은 빼도록 바꿨다. 다른 쇼핑몰 언급은 검색어에 유지한다.
- 확인하지 못한 원인: 첫 실패에서는 정책 답변과 출처가 없었고 근거 부족 안내도 없었다. 모델이 정책 검색을 호출하지 않은 경우로 보이지만 기록을 남기지 않아 확정하지 못했다.

수정 후 같은 테스트는 5회 연속 통과했다. 모델이 쓴 검색어는 `반품비` 4회, `반품 비용` 1회였다. 이어서 실제 모델 3건 전체, 단위 24건, 메모리 데모 8건, lint·typecheck·build를 통과했다. 이 도구 설명 변경을 키 없이 검증하는 회귀 테스트는 없다. PowerShell 7이 없으면 `scripts/*.ps1`의 `??` 연산자 때문에 스크립트가 실행되지 않는다. 이때는 같은 환경 변수를 셸에서 직접 지정하고 `npx playwright test`를 실행한다. 동일 질문에 반품 가능 주문이 4건일 때 카드도 4개인지 별도로 브라우저에서 확인했다. [RAG 평가](../tests/evals/README.md)의 48문항 결과는 이전 정책 QA 기준이며, 다중 턴 에이전트의 품질 수치로 해석하지 않는다.

### 2026-11-25 쇼핑몰 CS 시나리오 점검

[시나리오 실행기](../scripts/cs-scenarios.mjs)로 시나리오 45개(정책 19, 상품 4, 주문·반품 20, 접수 흐름 2)를 실제 모델과 로컬 DB에서 실행했다. 1차 결과는 정상 32개였다. 대화 상태, 모델이 고른 도구와 인자, 서버 응답을 기록해 원인을 확인한 뒤 공통 규칙으로 고쳤고, 최종 실행에서 45개가 모두 정상이었다.

- 정책 질문 답변: 조회 도구가 모두 보류(로그인 필요 등)일 때 정책 답변을 주 답변으로 둔다. 도구 없이 끝난 인사에는 주문번호 요청 대신 도움말을 보여준다(`agent-inquiry.ts`).
- 직접 처리하지 않는 요청: 취소, 배송지 변경, 교환, 반품 철회는 정책을 검색한 뒤 상담 문의를 제안하도록 도구 설명을 바꿨다(`agent-routing.ts`).
- 반품 흐름: 사유를 묻기 전에 DB 판정을 먼저 확인한다. 기한 초과나 검토 대상은 상담 확인으로, 배송 전이거나 이미 접수된 주문은 바로 안내한다(`agent-workflow.ts`).
- 주문 목록: `list_orders`에 배송 상태 필터를 추가했다. 답변의 건수와 카드는 같은 DB 결과에서 만든다.
- 제외 사유: 지목한 상품이 직전 목록에 없으면 같은 고객의 전체 주문에서 판정을 찾는다.
- 조기 종료: 모델이 도구 없이 끝내려 하면 한 번만 되묻는다. 되묻기에 문장으로 답하면 처음 고른 종료를 유지한다.
- 상품: 판매하지 않는 품목과 특정 사이즈 품절을 구분해 안내한다(`catalog.ts`).

검증 결과는 단위 35건, DB 48건, 실제 모델 브라우저 3건, 메모리 데모 8건, lint·typecheck·build 통과다. 실행기는 응답을 기록할 뿐이고 정답을 자동 판정하지 않는다. 이후 합성 정책 2개(`무통장 입금과 현금영수증`, `쿠폰과 적립금`)를 추가해 Style Shop 정책은 22개가 됐다. 직접 사용해 보다가 구매 요청("M 사이즈 주문 가능?", "구매하고 싶다니까")에 같은 상품 카드만 반복되는 문제가 나왔다. 확인해 보니 모델이 상품 검색만 반복했고, 주문 방법 근거와 재고 여부 답변이 없었다. 그래서 `주문 방법` 정책(23개째)을 추가하고, 사이즈를 지정한 검색은 재고 여부를 답하게 했다. 구매 요청에는 재고와 주문 방법 정책을 함께 쓰도록 도구 설명도 바꿨다. 무통장 입금, 현금영수증, 쿠폰·적립금 질문은 이제 출처와 함께 답하고, 다른 쇼핑몰 정책 질문은 계속 보류된다. 남은 한계로, 비로그인 정책 답변 뒤에 로그인 안내가 붙는 경우가 있다.

## 남은 작업

- 포트폴리오에서 먼저 개선할 후보는 P2-07 다중 턴 평가다. 1단계로 [다중 턴 단위 회귀](../tests/unit/agent-multiturn.test.ts)가 실제 `agent-inquiry`·`mock-orders`·`agent-workflow` 조립을 가짜 모델·가짜 DB로 검증한다(이전 주문 범위, 건수=카드, 정책 출처 전달, 번호를 지정한 제외 사유, 모델 턴에서 확정 RPC 미호출, 고객 확인 후 접수). 표현 다양성, `live-chat`의 출처 병합·활성 버전 확인, 단일 접수·만료·소유권은 2단계(실제 모델·로컬 DB)와 pgTAP 범위다.
- 확인된 제약: `live-chat`은 가장 최근의 `order_response`만 다음 턴에 넘긴다. 그래서 반품 가능 목록 다음에 주문번호나 상품명 없이 "이 주문은 왜 빠졌어?"라고 물으면 서버는 제외된 주문을 특정할 수 없고 전체 주문 판정을 보여준다. 번호나 상품명을 포함하면 해당 주문의 사유를 반환한다. 바꾸려면 세션 범위의 표시 주문 이력을 넘기는 설계 결정이 필요하다. 주문 조회 → 이전 주문 범위에서 반품 가능 목록 → 비용 근거 → 고객 확인과 단일 접수까지 다른 표현으로 반복 검증한다. 답변 문구, 주문 ID, 목록 건수, 출처와 DB 최종 상태를 구분해 확인한다.
- P2-02의 독립 `OrderProvider`와 외부 연동용 어댑터는 설계에 남아 있다. 현재는 서버의 모의 주문 모듈과 Supabase를 사용한다.
- CI/CD와 Vercel 배포(P1-16), 고객 피드백·사용량 UI(P1-13), OCR/Vision·Worker(Phase 3)는 별도 범위다.
- 인수인계 시점에 로컬 작업 트리에는 첫 Git 커밋이 없다. 같은 폴더에서 Claude Code를 열면 파일을 읽을 수 있다. 다른 머신이나 원격 세션으로 옮길 때는 소스와 문서를 별도로 전달하며 `.env.local`과 로컬 DB는 따로 구성한다.

Claude Code 시작 문구는 [후속 작업 프롬프트](CLAUDE_CODE_PROMPT.md)에 있다.

## 장바구니·모의 주문 (P2-09·P2-10, 2026-11-25)

- 상품·재고는 `mock_products`/`mock_product_options`(시드: `node scripts/seed-catalog.mjs`, 원본 `demo/catalog.json`).
- 모델 도구: `get_product`, `add_to_cart`, `update_cart_item`, `view_cart`, `prepare_checkout`. 주문 확정(`place_order`)은 모델 도구가 아니고 고객이 주문 확인 카드에서 누를 때만 `decide_agent_action`이 실행한다.
- 장바구니 쓰기는 확인 카드 없이 실행되는 유일한 쓰기다. 불변식: 로그인 고객 본인 장바구니만, 수량 1~10·재고 이내, 되돌릴 수 있음, `요청 ID:도구:상품:사이즈:수량` 키로 재전송 중복 방지(`mock_cart_requests`).
- 가격·재고는 확정 시점에 DB가 다시 계산한다. 초안 뒤 장바구니나 가격이 바뀌면 `cart_changed`로 거부, 재시도는 같은 주문을 반환하고 재고는 한 번만 차감(pgTAP `supabase/tests/shopping.sql`).
- 매 턴 서버가 현재 장바구니(`mock_cart_view`)를 모델 문맥 `currentCart`로 넣는다. "이대로 주문", "하나만", "빼줘"를 장바구니 기준으로 판단하게 하기 위해서다.

## 로컬 무료 모델 모드

- `SHOP_OPS_LLM=claude-cli` + `SHOP_OPS_FAKE_EMBEDDINGS=1` + `SHOP_OPS_LIVE_MODEL=1`이면 OpenAI 대신 설치된 `claude -p`(기본 `haiku`, `SHOP_OPS_CLAUDE_MODEL`로 변경)로 도구 선택·답변 생성을 한다. 운영(`NODE_ENV=production`)에서는 거부한다.
- 가짜 임베딩으로 바꾸면 정책을 다시 인덱싱해야 한다: `SHOP_OPS_FAKE_EMBEDDINGS=1 node scripts/seed-showcase.mjs`. OpenAI 임베딩으로 돌아갈 때는 같은 스크립트를 플래그 없이 다시 실행한다(임베딩 모델이 다르면 자동 재인덱싱).
- CLI 구조화 출력은 최상위 object만 받으므로 어댑터가 스키마를 `value`로 감싼다. 턴당 약 5~15초.
- 쇼핑 시나리오 S01~S08(`node scripts/cs-scenarios.mjs "^S0"`) Haiku로 전부 통과. 주문 확정은 임시 고객으로만 검증한다(데모 A·B 주문 건수는 문서·e2e에 고정).
