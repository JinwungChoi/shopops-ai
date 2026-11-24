# PRD — ShopOps AI CS Agent SaaS

> 버전: 1.0 · 작성일: 2026-11-23 · 상태: 구현 기준 초안  
> 제품명 **ShopOps AI**는 가칭이다. 이 문서의 Phase 1 범위는 다른 문서보다 우선한다.

## 1. 제품 개요

쇼핑몰 운영자가 자사 정책·FAQ·가이드를 등록하면 고객이 자연어로 질문하고, 시스템이 **해당 쇼핑몰의 근거 자료만** 검색하여 답변하는 멀티테넌트 AI 고객지원 SaaS. 이후 주문·배송·반품 API를 연결한 AI Agent와 이미지 OCR/Vision으로 확장한다.

**목표:** 취업용 풀스택/백엔드/AI 엔지니어링 포트폴리오. 단순 챗봇 화면이 아니라 데이터 격리, 근거 검색, 실패 처리, 보안 테스트, 측정 지표를 검증 가능하게 구현한다. 실상용 서비스로 전환할 수 있는 아키텍처를 고려하되, MVP 단계에서 불필요한 복잡도는 만들지 않는다.

### 문제 정의
- 쇼핑몰마다 배송·교환·반품 정책이 달라 범용 LLM 답변은 부정확할 수 있다.
- 반복 문의가 CS 담당자의 시간을 소모한다.
- 등록되지 않은 정보에 대해 AI가 추측하거나 다른 쇼핑몰의 정보를 섞으면 신뢰와 보안 문제가 생긴다.
- FAQ를 수정했을 때 AI 답변에 반영되었는지 확인하기 어렵다.

### 사용자·권한
| 역할 | 주 사용 목적 | Phase 1 권한 |
|---|---|---|
| Platform Operator | SaaS 운영 | 운영용 내부 계정/관측만. 범용 관리 UI는 제외 |
| Tenant Owner | 쇼핑몰 대표 관리자 | 쇼핑몰 생성, 구성원(최초 1명), 문서·상담 조회 |
| Tenant Staff | 쇼핑몰 상담원 | 문서 관리 및 채팅 조회 (초기 데모에서는 owner만 생성해도 됨) |
| End Customer | 쇼핑몰 방문 고객 | 공개 채팅 페이지에서 해당 쇼핑몰 문의, 자신의 상담 세션만 접근 |

**멀티테넌시 정의:** Phase 1의 '완전 분리'는 논리적 격리(tenant-scoped DB 행, 서버 인가, RLS, 벡터 검색 범위 제한)를 뜻한다. 업체마다 물리적으로 독립된 DB를 제공하는 것은 범위 밖이다.

## 2. 핵심 유저 스토리와 수용 기준

### US-01: 쇼핑몰 생성·관리자 인증 (P0)
- **As** 관리자 **I want** 회원가입 후 쇼핑몰을 생성 **so that** 자사 지식베이스를 관리한다.
- Supabase Auth 이메일 기반 가입/로그인·로그아웃 구현.
- `create_tenant` 서버 흐름에서 tenant와 owner membership을 원자적으로 생성.
- 다른 쇼핑몰 관리자 토큰으로 타 업체 문서·대화·티켓 조회를 시도하면 403 또는 404; DB 직접 요청도 RLS 차단.
- Phase 1에서 초대·복잡한 RBAC UI는 제외. DB는 owner/staff 역할을 수용하도록 설계.

### US-02: FAQ/Markdown 등록·갱신·삭제 (P0)
- **As** 업체 관리자 **I want** 배송/반품/상품 정보 문서를 작성 **so that** 챗봇이 최신 정책을 사용한다.
- 문서 종류: `faq`, `markdown`. PDF·이미지 업로드는 Phase 3.
- 제목, 본문, 유형, 상태, 마지막 인덱싱 시각 표시. FAQ는 질문과 답변을 한 문서 본문으로 취급.
- 저장 후 인덱싱 시작/재시도 가능. 최신 활성 버전의 청크만 검색됨.
- 실패는 `index_status=failed`, 오류 식별자 표시 및 재시도 가능(원문 유실 없음).
- 문서 수정·삭제 직후 이전 버전이 검색되지 않도록 **조회 시 `active_version` 확인**, 완전 갱신 전에는 문서를 검색에서 제외하거나 이전 활성 버전을 명시적으로 유지하는 정책 중 하나를 택한다. MVP 기본은 **수정 시 검색 제외 → 성공 시 새 버전 활성화**.

### US-03: 근거 기반 AI 고객상담 (P0)
- 고객은 `/chat/[publicWidgetKey]`에서 채팅을 시작한다.
- 서버는 위젯 ID에서 실제 tenant를 확인하고 임의의 `tenant_id` 입력을 무시한다.
- 질문 → tenant-scoped 자료 검색(top-k) → 검색 근거를 이용한 답변 → 출처 문서 표시.
- 관련 자료 없거나 정책 충돌·불확실성이 있으면 '쇼핑몰 담당자 확인이 필요합니다'라고 안내. 가격·환불을 임의 확정하지 않는다.
- 채팅 내역은 `chat_sessions`, `chat_messages`에 저장되며 세션 토큰 소유자만 재조회 가능.
- 스트리밍 응답은 선택 사항. 초기에는 비스트리밍 응답으로 일관성과 테스트를 확보.

### US-04: 업체 간 격리 (P0, 출시 차단 조건)
- Tenant A 고객이 Tenant B의 비공개 정책 고유 문구를 질문해도 B 문서 원문/답변/메타데이터가 노출되지 않음.
- Tenant A 관리자가 Tenant B의 문서 ID로 조회·수정·삭제 요청해도 실패.
- 공개 고객 A 상담 토큰으로 B 상담 세션 조회 실패.
- 검색 SQL은 `WHERE tenant_id = ...`와 활성 문서 조인을 반드시 포함. `tenant_id`는 **서버가 검증한 값**.
- 자동화 통합 테스트 통과를 MVP 출시 차단 조건으로 취급.

### US-05: 해결 불가 문의 티켓 (P1)
- 고객이 '상담원에게 문의' 버튼을 누르면 `support_tickets` 생성; AI가 자의적으로 생성하지 않음.
- 업체 관리자는 자기 업체 티켓만 보고 `open` → `in_progress` → `resolved`로 변경.
- 고객 연락처 입력은 선택적이며 목적·보관 기간을 안내한다. 데모 데이터는 가명만 사용.

### US-06: 품질 피드백과 사용량 (P1)
- 고객은 AI 답변에 '도움 됨/안 됨' 피드백 등록.
- LLM 호출 시 `model`, 입력/출력 토큰, 오류, latency, 추정 비용을 tenant 단위로 기록.
- API 비용은 실제 청구 내역과 차이 날 수 있는 **추정치**로 표시. 단가표는 날짜·모델별 설정으로 관리.

## 3. 기능 우선순위와 범위

| 기능 | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| 업체 생성·로그인·논리적 데이터 격리 | **P0** | 유지 | 강화 |
| FAQ/Markdown CRUD + 인덱싱 | **P0** | 유지 | PDF/이미지 지원 |
| RAG 검색 + AI 답변 + 출처 | **P0** | 유지 | Hybrid Search/Rerank 평가 |
| 채팅 세션, 대화 저장 | **P0** | 유지 | 운영 고도화 |
| 고객 티켓/피드백/간단 사용량 화면 | P1 | 강화 | 분석 강화 |
| 주문·배송 조회 | 제외 | **포함** | 유지 |
| Style Shop 합성 카탈로그 조회 및 상품 카드 | 제외 | 포함 | 유지 |
| 반품 자격 검증·승인·접수 | 제외 | **포함** | 유지 |
| LangGraph 실행/상태·재개 | 제외 | **포함** | 강화 |
| OCR(송장 텍스트), Vision(상품 파손 사진) | 제외 | 제외 | **포함** |
| 장시간 문서 처리 Worker, 큐, 모니터링 | 제외 | 필요 시 | **포함** |
| 결제, 고객사 과금, 실제 쇼핑몰 연동, 다국어 | 제외 | 제외 | 별도 계획 |

### Phase 1 비목표(의도적으로 구현하지 않음)
- 실제 쇼핑몰 로그인/결제/택배사 연계, 고객 주문 데이터 조회
- 상품 불량 판정, 환불 실행, OCR, 이미지 업로드
- 다중 에이전트, 복잡한 툴 조합, LangGraph, 별도 NestJS 서버
- 외부 고객 사이트 임베딩 스크립트(공개 데모는 우리 도메인 내 `/chat` 경로)
- 자동 과금·비즈니스 고객사 청구·SLA 보장

## 4. 주요 화면과 라우트

| 화면 | URL | 역할 |
|---|---|---|
| 로그인/가입 | `/login`, `/signup` | 관리자 |
| 쇼핑몰 선택/생성 | `/dashboard/tenants`, `/dashboard/tenants/new` | 관리자 |
| 지식베이스 | `/dashboard/[tenantSlug]/knowledge` | 관리자 |
| 지식 문서 상세/편집 | `/dashboard/[tenantSlug]/knowledge/[id]` | 관리자 |
| 상담 이력 | `/dashboard/[tenantSlug]/conversations` | 관리자 |
| 티켓 | `/dashboard/[tenantSlug]/tickets` | 관리자, P1 |
| 사용량 | `/dashboard/[tenantSlug]/usage` | 관리자, P1 |
| 고객 공개 채팅 | `/chat/[publicWidgetKey]` | 고객 |

## 5. API 요구사항(요약, 상세는 ARCHITECTURE.md)

### 인증된 관리자 API
- `POST /api/tenants` — 업체 생성
- `GET /api/tenants` — 소속 업체 목록
- `GET/POST /api/tenants/:tenantId/documents` — 목록/등록
- `GET/PATCH/DELETE /api/tenants/:tenantId/documents/:documentId` — 문서 관리
- `POST /api/tenants/:tenantId/documents/:documentId/index` — 재인덱싱
- `GET /api/tenants/:tenantId/conversations` — 상담 목록
- P1: `GET/PATCH /api/tenants/:tenantId/tickets`, `GET /api/tenants/:tenantId/usage`

### 공개 고객 API
- `POST /api/public/sessions` — 공개 위젯 키를 확인하고 세션 발급
- `POST /api/public/messages` — 세션 토큰 인증 후 고객 질문·답변
- `GET /api/public/sessions/:sessionId/messages` — 자기 세션만 조회
- P1: `POST /api/public/tickets`, `POST /api/public/feedback`

**명세 규칙:** 요청·응답·오류 코드는 `ARCHITECTURE.md`를 기준으로 한다. 모든 본문은 Zod 검증, 가능한 경우 request ID 포함.

## 6. 핵심 비기능 요구사항

### 보안 / 개인정보
- API 키와 Supabase secret key는 서버에서만 사용; `NEXT_PUBLIC_`에 절대 저장하지 않는다.
- 모든 tenant-scoped 테이블에 RLS 활성화; 운영·검색용 고권한 접근은 서버 인가 필수.
- 공개 채팅은 예측 불가능한 세션 토큰으로 보호(서버에는 해시만 저장); 새로고침 시 복원하지 않아도 되는 **메모리 보관**을 MVP 기본값으로 한다.
- 채팅 API에 IP/세션별 rate limit, 최대 입력 길이, 토큰 상한, 서버 측 타임아웃을 적용. 구현 환경에서 지속적인 제한 저장소 사용 가능 여부를 확인한다.
- 개인정보 최소 수집. 데모용 데이터만 사용하고 실제 주문·연락처·민감정보를 Git에 커밋하지 않는다.
- 검색 자료는 **데이터**이지 명령이 아니며, 자료 내 프롬프트 인젝션 지시를 무시하도록 방어한다.

### 성능 / 운영
- 대상: 동시 요청이 적은 공개 포트폴리오 데모. 사용자·처리량 SLA를 약속하지 않는다.
- 초기 문서 길이 제한(예: 문서당 10,000자), 청킹/임베딩 요청량 제한. 대량 작업은 후속 Worker로 이전.
- 인덱싱 재시도는 idempotent하게; 실패해도 원문 보존.
- DB 마이그레이션을 코드로 관리하고 리뷰 가능한 자동 테스트 확보.
- 장애와 API 오류 시 일반화된 오류 메시지 반환, 내부 로그에 원인 기록. LLM 응답이 실패해도 데이터 격리 위반은 없어야 한다.

## 7. 데모 데이터

고객 공개 시연은 의류몰 Style Shop 한 곳에서 진행한다. 두 테넌트의 합성 데이터는 격리·검색 평가에 사용한다.

**Tenant A:** `demo-style-shop` — 의류 쇼핑몰. 배송·교환·반품·사이즈 FAQ 20~30개.  
**Tenant B:** `demo-gadget-shop` — 전자기기 쇼핑몰. A와 서로 다른 배송·AS·반품 정책 20~30개.

- 두 업체 문서에 서로 겹치지 않는 **canary 문구**를 넣는다(예: `STYLE-ONLY-7Q2`, `GADGET-ONLY-9R4`). 이 문구는 데이터 격리 검증에만 사용.
- 평가 질문 40~60개: 답변 가능한 질문, 바꿔 말한 질문, 자료 없는 질문, 교차 업체 정보 요청.
- 실제 개인정보, 실주문·결제 데이터 사용 금지.

## 8. 성공 지표 및 검수 방법

| 지표 | 초기 목표 | 검증 방법 |
|---|---|---|
| 테넌트 권한/검색 격리 | 교차 접근 테스트 100% 차단 | API + DB RLS + 검색 통합 테스트 |
| 문서 최신성 | 변경 후 이전 활성 청크가 검색되지 않음 | 재인덱싱 시나리오 |
| Retrieval Recall@5 | 평가셋 기준 0.90 목표 | 기대 문서 ID와 top-5 결과 비교 |
| 근거 없는 답변 | 자료 없는 질문에 보류 답변 | 질문셋 자동+수동 평가 |
| 답변 출처 | 답변에 실제 검색된 문서만 노출 | source ID 검증 |
| 테스트·배포 | lint/typecheck/unit/e2e 통과 | CI 기록 및 Vercel 시연 URL |
| 비용 | 호출당 토큰·추정 비용 기록 | usage 로그 분석 |

위 숫자는 **목표**이지 실제 성능을 뜻하지 않는다. 사용자에게 실측되지 않은 점수를 성과로 표기하지 않는다.

## 9. 선행 결정 및 열린 이슈

1. **확정:** Phase 1은 Next.js + Supabase + pgvector + LangChain.js + OpenAI API, Vercel 배포.
2. **확정:** 기본 임베딩 `text-embedding-3-small`, 1536차원; 임베딩 모델 변경 시 전체 재인덱싱 필요.
3. **확정:** FAQ/Markdown만 1차 지원; PDF/OCR은 3차.
4. **확정:** 고객용 채팅은 플랫폼 동일 도메인 페이지; 외부 스토어 설치 위젯은 후속.
5. **협의 필요:** 사용자 인증 방식(이메일 인증 설정), 무료 데모 공개 범위, 보관 기간, 실제 서비스 개인정보 정책.
6. **구현 시 검증:** 선택한 OpenAI Chat 모델의 현재 API 지원 여부와 비용; `.env.example`의 모델명은 교체 가능하게 유지.

## 10. 문서 간 참조
- [ARCHITECTURE.md](./ARCHITECTURE.md) — 네트워크·API·실행 경계
- [DATABASE.md](./DATABASE.md) — SQL·RLS·인덱스
- [AI_DESIGN.md](./AI_DESIGN.md) — RAG 및 Agent 설계
- [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) — 태스크·검수·마일스톤
- [../AGENTS.md](../AGENTS.md) — Codex 실행 규칙
