# ShopOps AI

의류몰 Style Shop의 정책 검색, 상품 추천, 주문·배송 조회, 고객 확인을 거친 모의 반품 접수를 보여주는 AI CS 에이전트 포트폴리오입니다. 고객 시연에는 Style Shop이 표시되며, 테넌트 격리는 별도 테스트에서 검증합니다.

작업을 이어받을 때는 [인수인계 문서](docs/HANDOFF.md)와 [Claude Code 시작 프롬프트](docs/CLAUDE_CODE_PROMPT.md)를 사용합니다.

## 빠른 데모

Node.js 24 및 npm 환경에서 실행합니다.

```sh
npm ci
npm run dev
```

브라우저에서 http://localhost:3000 을 엽니다. API 키 없이 실행되는 모드는 브라우저별로 분리한 합성 데이터를 서버 메모리에 보관합니다. 화면에서 다음 순서로 확인할 수 있습니다.

1. Style Shop에서 **반품 기간**을 누릅니다. 열흘이 지난 문의에 7일 정책이 표시됩니다.
2. **지식베이스**에서 Style Shop의 반품 기간을 21일로 바꿉니다. 저장 직후 상담은 근거 부족으로 보류합니다. **다시 인덱싱**하면 다음 답변에 v2 정책이 표시됩니다.
3. **할인 쿠폰 있나요?**를 보내면 등록된 근거가 없어 담당자 확인을 안내합니다.

키 없는 화면 데모에서는 규칙 기반 검색과 답변을 사용합니다. 변경은 워크스페이스 쿠키와 서버 메모리의 수명 안에서 유지됩니다.

## 로컬 Supabase 모드

Docker와 Supabase CLI가 필요합니다.

```sh
supabase start
supabase migration up --local
```

로컬 Supabase의 접속 정보를 본인의 `.env.local`에 넣고 `SHOP_OPS_BACKEND=supabase`, `SHOP_OPS_FAKE_EMBEDDINGS=1`을 설정한 뒤 개발 서버를 다시 실행합니다. 앱에서 개발용 계정 가입, 쇼핑몰 생성, FAQ 등록과 인덱싱, **공개 상담 열기** 순으로 사용할 수 있습니다. 기본 데모의 Style Shop은 Supabase DB에 자동으로 생성되지 않습니다. 기존 로컬 시연 업체의 정책, 체험 질문과 상품 사진은 [시연 가이드](demo/README.md)에 있습니다.

Supabase 모드는 Auth, 관리자 JWT와 RLS, 서버 전용 pgvector 검색 RPC, 고객 bearer 세션과 상담 이력을 사용합니다. 합성 임베딩은 1536차원 문자 특징 벡터로 DB 연동을 검증합니다. 검색 품질 지표는 실제 모델과 별도 평가셋으로 측정해야 합니다. 실제 모델 연결에는 `SHOP_OPS_FAKE_EMBEDDINGS=0`, `SHOP_OPS_LIVE_MODEL=1`, API 키 및 지원 모델 설정이 필요합니다. 임베딩 어댑터를 바꿀 때 기존 문서도 새 모델로 다시 인덱싱해야 합니다.

## 검증

```sh
npm run lint
npm run typecheck
npm run test
npm run build
npx playwright install chromium --only-shell
npm run test:e2e
supabase test db
pwsh -NoProfile -File scripts/test-local-supabase.ps1
```

마지막 명령은 실행 중인 로컬 Supabase에서 합성 계정을 생성해 Auth, 문서 인가, 벡터 검색, 버전 갱신, 상담 토큰 격리를 검사합니다. 테스트는 별도 포트에서 앱을 띄우며 실제 모델을 호출하지 않습니다.

### 실제 모델 스모크 테스트

프로젝트 루트의 `.env.local`에 `OPENAI_API_KEY`를 설정한 뒤 아래 명령을 실행합니다.
`-LiveModel`은 OpenAI의 `gpt-6-luna`와 `text-embedding-3-small`을 호출하고 사용량이 청구됩니다.

```powershell
pwsh -NoProfile -File scripts/test-local-supabase.ps1 -LiveModel
pwsh -NoProfile -File scripts/test-local-supabase.ps1 -LiveModel -Serve
```

첫 명령은 격리, 출처, 보류와 버전 갱신을 확인합니다. 두 번째 명령은 http://127.0.0.1:3031 에서 Supabase 관리자 화면과 공개 상담을 실행합니다.

합성 FAQ에서 짧은 한국어 반품 질문과 정책 문장의 cosine distance가 약 0.62로 측정됐습니다. 현재 후보 기준은 0.65입니다. 문서와 질문이 늘어난 평가셋에서 검색 적중률과 보류를 다시 측정할 예정입니다.

## RAG 품질 평가

합성 정책 40개와 질문 48개를 실제 OpenAI 모델 및 pgvector로 평가했습니다. 실행 방법, 기준선 비교와 남은 실패는 [평가 보고서](tests/evals/README.md)에 기록했습니다.

## 디자인 참고

[Mobbin](https://mobbin.com/)의 앱 흐름·모션 레퍼런스, [Linear](https://linear.app/)의 작업공간 내비게이션, [Claude](https://www.anthropic.com/claude)의 대화 중심 입력 흐름을 참고했습니다. ShopOps에는 쇼핑몰 스위처, 답변과 연결된 근거 패널, 모바일에서 펼칠 수 있는 출처를 적용했습니다. 상태가 바뀔 때 짧은 전환을 사용하며 시스템의 모션 줄이기 설정을 따릅니다.

## 현재 범위

로컬 포트폴리오 데모에서 상품 카드와 재고, 모의 주문·배송 조회, 반품과 상담 문의 접수까지 확인할 수 있습니다. 실제 쇼핑몰·택배사·결제 연동, Phase 3 OCR/Vision, Vercel 배포와 독립 평가셋 검증은 후속 범위입니다. 공개 운영 전에는 배포상의 IP 식별, 장기 비용 한도, 보관 기간과 삭제 절차를 확정해야 합니다.
