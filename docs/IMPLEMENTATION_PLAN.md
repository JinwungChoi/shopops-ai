# IMPLEMENTATION_PLAN — Codex 단계별 작업 계획

> 버전: 1.0 · 순서가 중요하다. **Phase 1 우선**. 사용자가 승인한 P2-08 로컬 상품 시연과 P2-01~03 읽기 전용 모의 주문·도구 선택은 P1-15 검증 범위 뒤에 진행한다.

이 문서는 작업 ID와 원래 단계 의존성을 기록한다. 현재 로컬 코드의 구현 및 검증 범위는 [인수인계](HANDOFF.md)에서 확인한다.

## 0. 개발 운영 규칙

1. 각 작업 전에 `AGENTS.md`, 관련 docs 읽기. 해당 작업 ID 외 기능을 추가하지 않기.
2. 각 작업은 계획 → 최소 구현 → 자동 테스트 → 문서 갱신 → 커밋 가능한 상태를 목표.
3. 복잡한 작업은 PR/커밋 단위 분할. 단위 테스트 없는 보안·권한 코드는 완료 처리 금지.
4. 모든 변경은 `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`를 실행(미정의 스크립트는 생성). DB 관련 작업은 Supabase 로컬/격리 테스트 프로젝트에서 migration/테스트.
5. 사용자가 명시하지 않은 외부 서비스 리소스 생성, 결제, 프로덕션 데이터 삭제/마이그레이션은 금지.
6. 작업 종료 보고: 변경 파일, 구현 내용, 실행한 테스트와 결과, 실패·제약, 다음 추천 작업 ID.

## 1. 마일스톤과 기간(추정)

| 일정 | 목표 | 출하 게이트 |
|---|---|---|
| W1 | App/Auth/DB 기반 | 관리자 로그인·업체 생성·RLS 격리 테스트 |
| W2 | FAQ/Markdown 인덱싱 | 문서 CRUD·벡터 생성·버전/재시도 |
| W3 | RAG 채팅 | 2개 tenant의 분리된 답변/출처·보류 |
| W4 | 운영 UI/P1 | 상담 이력·기본 티켓·사용량 |
| W5 | AI 품질/보안 검증 | 평가셋, 격리·악성 입력·회귀 테스트 |
| W6 | 배포/포트폴리오 | Vercel 데모 + README·아키텍처·성과 |

**추정:** RAG·LangChain 첫 프로젝트를 혼자 개발하는 기준 4~6주 이상. 실제 속도는 학습/기존 코드/사용시간에 따라 달라진다. `P0` 미완료 시 P1·Phase 2 확장 금지.

## 2. Phase 1 — 작업 ID 및 검수 조건

### M0 — 저장소/환경 (필수)

#### P1-00 프로젝트 초기화
- **선행:** 없음.
- **작업:** Next.js App Router, TypeScript strict, ESLint, Prettier(선택), Tailwind + shadcn/ui; `src/` 구조; package scripts; `.gitignore`, `.env.example`, README 초기 템플릿.
- **검수:** `npm run lint`, `typecheck`, `test`, `build` 동작. 비밀 키·`.env.local` 미커밋.
- **산출물:** 초기 소스, `README.md`, `.env.example`.

#### P1-01 Supabase 환경
- **선행:** P1-00.
- **작업:** 로컬 Supabase CLI 및 별도 Dev 프로젝트 연결. browser/server user client 분리, secret client는 server-only module. Auth session 검증.
- **검수:** 로그인 사용자와 비로그인 사용자의 API 결과 구분. 브라우저 번들에 secret key 미포함.
- **산출물:** auth helpers, 구성 점검 문서.

### M1 — Multi-tenant core (P0)

#### P1-02 DB migration / tenant 생성
- **선행:** P1-01.
- **작업:** `DATABASE.md`의 Phase 1 테이블, unique·FK·index·RLS, `private.is_tenant_member`, `public.create_tenant` RPC. 모든 SQL을 실제 migration 파일로 분리.
- **검수:** 새 DB에 `supabase db reset` 성공; 동일 migration 재적용 시 예상한 동작; tenant 생성에 owner membership 1개 발생.
- **주의:** SQL 샘플의 확장 스키마·PostgreSQL 버전 지원성 검증, 실패 시 문서와 migration 동시 업데이트.

#### P1-03 Auth/Role 및 격리 테스트
- **선행:** P1-02.
- **작업:** `requireTenantRole` helper, tenant selector UI, RLS integration tests.
- **검수:** A admin으로 B docs/chat 읽기 0건; A가 B ID로 API를 호출하면 403/404; 인증 없는 API는 401.

#### P1-04 데모 시드 데이터
- **선행:** P1-02.
- **작업:** 의류 쇼핑몰 A·전자기기 쇼핑몰 B, FAQ 20~30개씩, 서로 다른 정책과 canary 문구. 가짜 Auth 계정은 로컬 seed script에서 생성.
- **검수:** `npm run seed:demo` 등 명령으로 반복 가능; 테스트 데이터만 생성; prod에서 자동 실행되지 않음.

### M2 — Knowledge / Ingestion (P0)

#### P1-05 문서 CRUD API와 UI
- **선행:** P1-03.
- **작업:** 인증된 문서 조회/등록/수정/soft delete; Zod, pagination, 에러 처리; 문서 종류 `faq`/`markdown`.
- **검수:** 다른 tenant ID로 CRUD 불가; 유효성 오류 400; 삭제 직후 검색 대상에서 제외.

#### P1-06 청킹·임베딩
- **선행:** P1-05.
- **작업:** text normalizer, FAQ Q/A 보존, Markdown chunker, embeddings adapter, 단건/소량 batched embedding.
- **검수:** deterministic chunker unit tests; vector 차원=1536; 빈/초과 크기 문서 오류 처리; FakeEmbeddings로 테스트 가능.

#### P1-07 인덱싱 트랜잭션·상태 관리
- **선행:** P1-06.
- **작업:** `index_jobs`, 상태 pending→indexing→ready/failed, 문서 버전, 인덱스 publish 원자성, 재시도/중복 방지.
- **검수:** v1→v2 업데이트 후 v1 미검색; 임베딩 실패 후 원문 보존/재시도; 동시 인덱싱 중복 청크 없음.
- **주의:** OpenAI API 대기 동안 DB transaction 열지 않기. 부분 성공된 SQL 다중 요청을 원자적이라고 주장하지 않기.

#### P1-08 pgvector Tenant 검색
- **선행:** P1-07.
- **작업:** `search_tenant_chunks` RPC, `tenantRetriever` adapter, no evidence fallback, topK config.
- **검수:** 같은 질문/같은 embedding으로 A/B 검색 자료 분리; 직접 authenticated/anon RPC 호출 거부; status != ready 자료 제외.

### M3 — Customer Chat / RAG (P0)

#### P1-09 공개 고객 세션·남용 방지
- **선행:** P1-03.
- **작업:** publicWidgetKey resolve, 32-byte random session token 발급·해시 저장, TTL, 메모리 보관 프론트, `Authorization: Bearer` 검증, rate limit 및 최대 요청 길이.
- **검수:** session A token으로 B session 읽기 거부; 만료/변조 토큰 401; 요청 제한 발생; DB에 원문 토큰 없음.
- **주의:** 위젯 키는 공개 식별자이며 인증 수단 아님. Origin 헤더만으로 인증했다고 간주 금지.

#### P1-10 RAG 답변 파이프라인
- **선행:** P1-08, P1-09.
- **작업:** 고객 질문 저장, 임베딩/검색, evidence 생성, LLM 호출, 근거 검증, 대화 저장, abstention, usage 로그.
- **검수:** A 문서만 출처; 없는 정보 보류; 모델 실패 시 개인정보/시크릿 노출 없음; 참조 chunk ID는 실제 검색 결과에 속함.

#### P1-11 고객 채팅 UI + 상담 조회
- **선행:** P1-10.
- **작업:** 공개 `/chat/[publicWidgetKey]`, 채팅 상태/로딩/오류/재시도, 출처 문서 표시, admin 상담 목록/상세.
- **검수:** 엔드투엔드 A/B 채팅 시나리오; 로그아웃 시 관리자 화면 접근 불가; 응답의 출처 링크는 tenant 경계를 넘지 않음.

### M4 — Complete workflow / P1

#### P1-12 상담 티켓
- **선행:** P1-11.
- **작업:** 고객 버튼으로 미해결 티켓 접수, 관리자 목록/상태 변경, 중복 제출·세션 확인.
- **검수:** 고객 승인/버튼 없이 자동으로 티켓 생성 안 됨; B 직원이 A 티켓 접근 불가; 상태 전이 테스트.

#### P1-13 피드백·사용량
- **선행:** P1-10.
- **작업:** helpful/unhelpful, 모델 토큰 추정 비용(단가 설정), 대시보드.
- **검수:** 피드백 대상 메시지/세션 검증; 토큰 합산·날짜 필터; 추정치 표기; 실패 호출 기록.

### M5 — Security / Quality

#### P1-14 자동 RAG 평가
- **선행:** P1-11, P1-04.
- **작업:** `tests/evals/dataset.jsonl` 형식, recall@5, 보류 테스트, 근거 일치 수동 검증 프로세스.
- **검수:** `npm run eval:rag`에서 전체/업체별 점수·실패 케이스 출력; 성능 수치는 실제 실행 후에만 문서화.

#### P1-15 회귀·보안·프롬프트 인젝션
- **선행:** P1-14.
- **작업:** RLS, 다른 업체 canary 공격, 임의 세션 재사용, 문서 속 악성 프롬프트, 재인덱싱 실패, XSS/입력 제한.
- **검수:** 교차 업체 데이터 노출 0건; SQL·API 권한 테스트 통과; 깨지는 사례는 수정 뒤 회귀 케이스 추가.

### M6 — Shipping / Portfolio

#### P1-16 CI/CD와 Vercel 배포
- **선행:** P1-15.
- **작업:** GitHub Actions lint/typecheck/test/build, Vercel preview/prod 환경, Supabase dev/prod 분리, migration 적용 절차, health/smoke.
- **검수:** PR 검사 통과, 배포 주소 접속, 로그인→문서 등록→챗봇 응답; secret 미노출.

#### P1-17 README·시연 자료·성과 정리
- **선행:** P1-16.
- **작업:** 프로젝트 소개, ERD, 아키텍처, RAG sequence, 기술 결정/대안, CI, 성능·비용 측정, 캡처/데모 영상, 트러블슈팅.
- **검수:** 다른 개발자가 README로 Dev 환경 실행 가능; '예시 수치'와 '실측 수치' 명확히 구분.

## 3. Phase 2 백로그

| 작업 ID | 작업 | 의존성 | 수용 기준 |
|---|---|---|---|
| P2-01 | Mock commerce DB/API | P1-17 | 주문·배송·반품 테스트 데이터, 소유권 확인 |
| P2-02 | `OrderProvider` 인터페이스 | P2-01 | 외부 연동 교체 가능한 adapter, fake provider tests (보류: 현재 P2-03 이후 도구는 서버 모의 주문 모듈 `mock-orders.ts`와 Supabase를 직접 사용) |
| P2-03 | Tool Calling (read-only) | P2-02 | 주문 조회·배송 조회·정책 검색, tenant/고객 검증 |
| P2-04 | LangGraph intent/state | P2-03 | 문의 분기, 상태 저장, 재개, 재시도 상한 |
| P2-05 | 반품 정책 엔진 | P2-04 | 고객·주문 검증, 기간/상태 검증은 서버 규칙 |
| P2-06 | 고객 승인 후 반품 요청 | P2-05 | idempotency, confirmation, audit, 무단 실행 0건 |
| P2-07 | Agent 통합 테스트/데모 (다중 턴 평가) | P2-06 | RAG→주문조회→고객승인→반품 접수 시연. 1단계: 가짜 모델·가짜 DB로 주문 범위, 건수=카드, 비용 출처 전달, 제외 사유, 고객 확인 후 접수 경계를 검증하는 단위 회귀(`tests/unit/agent-multiturn.test.ts`). 2단계: 실제 모델로 다른 표현 반복과 DB 최종 상태 확인 |
| P2-08 | Style Shop 합성 상품 검색·추천 카드 | P1-15 | 읽기 전용 카탈로그, 같은 세션의 조건 좁히기, 품절·결과 없음·정책 상담 회귀 검증 |

## 4. Phase 3 백로그 (Phase 2 완료 후)

| 작업 ID | 작업 | 수용 기준 |
|---|---|---|
| P3-01 | 안전한 이미지 업로드 | MIME/매직바이트/용량/비공개 Storage/만료 URL |
| P3-02 | 송장·영수증 OCR | 구조화된 필드 추출 + 오류/낮은 신뢰도 사용자 확인 |
| P3-03 | 상품 사진 Vision 분석 | 관찰 내용만 전달, 불량·환불 자동 확정 금지 |
| P3-04 | 인덱싱/비전 Worker + Queue | retry, idempotency, DLQ, 장애 복구 |
| P3-05 | Monitoring/Evaluation | latency, 비용, 누락·환각, 실패·재시도 관측 |
| P3-06 | 배포 아키텍처 확장 | 필요한 경우 Railway/NestJS + VPS/Docker 분리 |

## 5. 릴리스 게이트(Definition of Done)

다음 모두 만족해야 `Phase 1 complete`:

- [ ] 로그인·업체 생성·FAQ 등록·수정·삭제·인덱싱 E2E 성공.
- [ ] 공개 고객 상담에서 업체별 문서 검색 및 출처 표시 성공.
- [ ] 잘 모르는 질문은 추측 없이 보류.
- [ ] 인증/인가, RLS, 검색, 고객 세션에서 교차 테넌트 접근 차단 테스트 100% 통과.
- [ ] 문서 버전 변경·실패·재시도·삭제 이후 stale chunk 미노출.
- [ ] 유료 API 호출 수 제한·키 관리·비용 기록 적용.
- [ ] 코드 품질/lint/typecheck/unit/integration/e2e 및 build 통과.
- [ ] Vercel 배포 + Supabase 운영 환경 확인; 데모 계정과 가짜 데이터 준비.
- [ ] README에 실제 RAG 평가 결과, 실패 사례, 개선 기록이 명시됨.

## 6. Codex 권장 첫 세션 프롬프트

```text
프로젝트 루트의 AGENTS.md와 docs의 5개 Markdown 문서를 모두 읽어주세요.
지금은 Phase 1의 P1-00부터 시작합니다. Phase 2/3 기능은 구현하지 마세요.
먼저 문서 간 충돌, 현실적인 기술 제약, 보안 위험을 10개 이하로 정리하고
P1-00의 작업 계획과 검증 명령을 제시해주세요.
설계 자체를 임의로 바꾸지 말고 변경이 필요하면 이유와 최소 수정안을 설명하세요.
계획 검토 후에만 실제 파일을 생성하고, 완료 시 변경 목록과 테스트 결과를 보고해주세요.
```

## 7. Codex 후속 세션 템플릿

```text
AGENTS.md 및 관련 docs를 읽고 작업 ID [P1-XX]만 구현해주세요.
선행 작업의 테스트가 통과하는지 확인하고, 해당 작업의 Acceptance Criteria를
자동 테스트로 재현하세요. 범위를 벗어나는 구현이나 외부 과금 리소스 생성은 금지합니다.
완료 후 변경된 파일, 실행한 명령 및 결과, 알려진 문제, 다음 작업 ID를 보고하세요.
```

## 8. 작업 보고 양식

```markdown
### Completed: P1-XX
- Summary:
- Changed files:
- Acceptance criteria:
- Tests run: (pass / fail / not run + reason)
- Security checks:
- Known limitations:
- Next suggested task:
```
