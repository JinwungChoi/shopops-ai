# AGENTS.md — Codex 작업 규칙

> 이 파일은 저장소 루트에 둔다. **코드가 없더라도** 작업 시작 전 반드시 읽는다.

## 1. 프로젝트 목적과 우선순위

ShopOps AI는 **멀티테넌트 쇼핑몰 AI CS Agent SaaS** 포트폴리오다. 초기 릴리스는 운영 가능한 형태의 작은 **RAG 챗봇**으로 한정한다. Phase 2에 Tool Calling + LangGraph + mock ecommerce API, Phase 3에 OCR/Vision + Worker/관측을 추가한다.

**우선순위:** (1) 데이터 격리/보안 (2) 검증 가능한 정확성 (3) 기능 완성 (4) 운영 가능성 (5) UI 미관.

## 2. 반드시 읽을 문서 (충돌 시 적용 순서)

1. `docs/PRD.md` — 제품/Phase 범위와 Acceptance Criteria.
2. `docs/ARCHITECTURE.md` — API, 서비스 경계, 인증·세션.
3. `docs/DATABASE.md` — DB, 관계, RLS, 검색 함수.
4. `docs/AI_DESIGN.md` — RAG, 모델, Agent 및 Vision.
5. `docs/IMPLEMENTATION_PLAN.md` — 작업 순서와 작업 ID.

문서 간 모순이 있으면 임의 해석으로 구현하지 말고 **영향 범위와 수정 제안**을 보고한다. 특히 Phase 1에서 Phase 2/3를 미리 구현하지 않는다.

## 3. 기술 및 아키텍처 규칙

- Phase 1: Next.js App Router, React, TypeScript(strict), Supabase Auth/PostgreSQL/pgvector, LangChain.js, OpenAI API, Vercel.
- `src/server/`의 모듈은 Server Only; API 키·Supabase secret key는 `NEXT_PUBLIC_` 변수에 넣지 않는다.
- 프론트엔드는 외부 OpenAI를 직접 호출하지 않는다. DB 변경은 인증된 Next.js API가 소유한다.
- `tenantId`는 사용자 입력·프롬프트·툴 인자에서 **신뢰하지 않는다**. 반드시 인증된 멤버십 또는 검증된 고객 세션에서 서버가 바인딩한다.
- 모든 tenant-owned row는 `tenant_id`와 FK로 연결하고 RLS 적용. 공개 채팅은 DB 직접 조회 금지.
- 관리자 읽기는 user JWT + RLS, 서버 고권한 DB 쓰기는 사전 AuthN/AuthZ가 필요하다. secret key를 쓰는 코드를 추가할 때는 관련 위협·테스트를 같이 추가한다.
- 모든 외부 요청은 Zod 등 런타임 검증. 페이지네이션, 입력 제한, rate limit, 타임아웃과 예외 처리 적용.
- `LangChain`·OpenAI 연동은 어댑터로 감싼다. Phase 1은 **결정적 retrieve→generate** 흐름; Agent의 자율 작업·LangGraph는 Phase 2.
- 프롬프트의 근거 문서에는 외부 명령이 포함될 수 있다. 텍스트 자료를 정책이나 인증 지시로 승격하지 않는다.
- AI 출력은 사실 판정이 아님. 주문 조회·반품 가능 여부·실행은 서버 비즈니스 규칙 및 사용자 동의로 결정한다.
- 신규 종속성·서비스·백그라운드 구성요소를 추가할 때는 '왜 기존 구성으로 불충분한가'를 기록한다. 불필요한 마이크로서비스/쿠버네티스 금지.

## 4. 코드 품질 규칙

- TypeScript `strict`; `any` 회피, 예외는 구체적인 error type.
- 서버 코드에서 UI import 금지. API Route는 요청 검증·인증·service 호출에 집중. DB 접근은 repository 또는 단일 service 계층.
- UUID, slug, tenant ID를 구분한 타입/스키마로 실수를 줄인다.
- 동적 SQL 문자열 연결 금지, query parameter 사용. 마이그레이션은 `supabase/migrations`에 저장.
- 클라이언트의 HTML/Markdown 렌더는 XSS 방어. 평가·로그에 개인정보/시크릿/원문 전체 저장 금지.
- 외부 API와 테스트는 fake/mock gateway로 격리. 시간·난수·현재 사용자 정보는 주입 가능하도록 설계.
- 파일명/폴더명/API 엔드포인트는 영어, 제품 문서와 코드 주석은 한국어 중심(기술명 영어 사용).

## 5. 테스트를 빠뜨리지 않는 규칙

- 모든 기능과 버그 수정에는 관련 unit/integration/e2e 중 최소 1개 이상 회귀 테스트를 작성.
- 다음 테스트 실패 시 해당 작업을 완료 처리하지 말 것:
  - A 관리자의 B 데이터 접근 차단 / B 문서 인덱싱 차단
  - A 고객 토큰의 B 채팅 접근 차단
  - 검색 RPC 직접 사용자 실행 차단
  - 검색 결과에 다른 tenant 청크가 하나도 없는지 검증
  - 이전 버전 청크, 삭제 문서 검색 결과 제외
  - 근거 없는 질문의 보류 응답
  - LLM이 반환한 가짜 출처 ID 차단
- API 키가 없을 때 unit 테스트는 fake adapter로 실행 가능해야 한다.
- 테스트는 가짜 쇼핑몰·주문·문서로 구성한다. 실제 개인정보를 시드하거나 Git에 넣지 않는다.

## 6. 외부 시스템 안전 규칙

- 명시적 요청 없이 실제 외부 고객사 계정 생성, 결제, 구독 변경, 메일/SMS 발송, 배포용 리소스 생성·삭제를 하지 않는다.
- 파괴적인 SQL (`DROP`, 대량 `DELETE`, `TRUNCATE`)은 사용자가 승인한 격리 개발 DB에만 사용. 프로덕션 DB에는 직접 실행 금지.
- Supabase secret key와 OpenAI API key를 콘솔·응답·README·테스트 스냅샷에 노출하지 않는다.
- 네트워크·외부 서비스에 접근할 수 없으면 **모킹된 로컬 구현과 검증 범위**를 명시하고 성공했다고 주장하지 않는다.
- 작업이 막히면 변경을 최소화하고, 실제 실패 원인과 다음 복구 방안을 보고한다.

## 7. Codex 작업 사이클

1. 현재 요청의 작업 ID 확인 (예: `P1-05`).
2. `AGENTS.md` + 해당 docs + 현 소스 읽기.
3. 필요한 영향 범위/리스크·완료 조건을 짧게 계획.
4. 해당 범위만 구현. 문서 수정을 유발하면 함께 갱신.
5. `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build` 실행(가능한 경우). DB 보안 작업은 격리 테스트.
6. 변경 파일·수용 기준별 결과·테스트 명령·미해결 사항을 구조화해 보고.
7. 다음 작업은 **제안만** 하고 현재 요청하지 않은 Phase를 구현하지 않는다.

## 8. 완료 보고 양식

```markdown
### Task ID: P1-XX
**Summary**
- ...
**Changed files**
- ...
**Acceptance criteria**
- [x] ...
- [ ] ... (reason)
**Verification**
- `npm run lint` — passed/failed/not run + reason
- `npm run typecheck` — ...
- `npm run test` — ...
- `npm run build` — ...
**Risks / decisions**
- ...
**Next task**
- P1-YY
```

## 9. 시작 시 권장 안내

프로젝트가 빈 디렉터리라면 바로 전체 서비스를 만들지 않는다. 먼저 `docs/IMPLEMENTATION_PLAN.md`의 `P1-00`부터 시작한다. 프롬프트는 해당 문서의 'Codex 권장 첫 세션 프롬프트'를 사용한다.
