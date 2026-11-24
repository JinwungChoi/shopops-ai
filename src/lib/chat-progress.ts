import type { Answer } from "./demo";

export const progressLabels = {
  request: "요청 확인 중",
  routing: "요청에 맞는 도구 선택 중",
  review_result: "조회 결과 확인 중",
  search_policies: "쇼핑몰 정책 확인 중",
  search_products: "상품과 사이즈 재고 확인 중",
  list_orders: "최근 주문 내역 조회 중",
  track_shipment: "택배 이동 기록 확인 중",
  check_return_eligibility: "주문과 반품 조건 확인 중",
  submit_return_request: "반품 접수 중",
  create_support_ticket: "상담 문의 접수 중",
  compose: "확인한 정책으로 답변 정리 중",
} as const;

export type ProgressStage = keyof typeof progressLabels;
export type ReportProgress = (stage: ProgressStage) => void;
export type ChatEvent =
  | { type: "progress"; stage: ProgressStage }
  | { type: "answer"; data: Answer }
  | { type: "error"; message: string };
