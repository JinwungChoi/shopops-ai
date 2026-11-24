import { z } from "zod";

export const referenceSchema = z.string().regex(/^STY-[0-9]{4,8}$/u);
export const actionReasonSchema = z.enum(["change_of_mind", "damaged", "wrong_item", "missing_delivery", "policy_review", "staff_requested"]);
export type ActionReason = z.infer<typeof actionReasonSchema>;
export const agentStateSchema = z.object({
  intent: z.enum(["return", "support"]),
  reference: referenceSchema.nullable(),
  reason: actionReasonSchema.nullable(),
  waiting: z.enum(["order", "reason", "approval", "closed"]),
  approvalId: z.uuid().optional(),
  approvalKind: z.enum(["return", "support"]).optional(),
}).strict();
export type AgentState = z.infer<typeof agentStateSchema>;
export type ActionIntent = {
  intent: AgentState["intent"];
  reason: ActionReason | null;
  productHint: string | null;
  policyQuery: string | null;
  orderReference?: string;
};
export const reasonLabels: Record<ActionReason, string> = {
  change_of_mind: "단순 변심",
  damaged: "상품 파손·하자",
  wrong_item: "오배송",
  missing_delivery: "배송 완료 후 미수령",
  policy_review: "반품 조건 검토",
  staff_requested: "상담원 문의",
};

export function orderReference(question: string) {
  return question.toUpperCase().match(/\bSTY-[0-9]{4,8}\b/u)?.[0] ?? null;
}

export function isReturnableOrderListQuestion(question: string) {
  const compact = question.replace(/\s|[.!?]/gu, "");
  return /^(?:(?:내|제)?주문중(?:에)?|지금|현재|그중(?:에)?)*(?:반품가능한|반품할수있는)(?:게|건|거|것|상품|품목|주문|주문내역|목록)*(?:어떤(?:거야|건가요|게있어|게있나요)|뭐(?:야|예요|가있어|가있나요)|있어(?:요)?|있나요|알려(?:줘|주세요)|보여(?:줘|주세요)|조회(?:해줘|해주세요))?$/u.test(compact);
}

export function reportedMissingDelivery(question: string): ActionIntent | undefined {
  if (/^(?:STY-[0-9]{4,8}\s+)?배송\s*완료(?:라는데|라고\s*(?:뜨는데|하는데)|로\s*(?:뜨는데|나오는데))\s*(?:아직\s*)?(?:못\s*받았|받지\s*못했|택배가\s*없)/iu.test(question.trim())) {
    return { intent: "support", reason: "missing_delivery", productHint: null, policyQuery: null };
  }
}

export function reasonIn(question: string): ActionReason | null {
  if (/오배송|다른 (?:상품|제품)이? (?:왔|도착)/u.test(question)) return "wrong_item";
  if (/파손|불량|하자|깨져|찢어/u.test(question)) return "damaged";
  if (/못 받았|못받았|미수령|받지 못|택배가 없/u.test(question)) return "missing_delivery";
  if (/변심|마음이 바뀌|마음이 바뀌었|마음에 안/u.test(question)) return "change_of_mind";
  return null;
}

export function followUpIntent(question: string, prior?: AgentState): ActionIntent | undefined {
  if (!prior || prior.waiting === "closed" || prior.waiting === "approval") return;
  const reason = reasonIn(question);
  const selected = referenceSchema.safeParse(question.trim().toUpperCase()).success;
  const simpleReason = /^(?:단순\s*변심|마음이\s*바뀌었어요|파손|상품\s*파손|불량|하자|오배송)[.!]?$/u.test(question.trim());
  if (!selected && !(prior.waiting === "reason" && simpleReason && reason)) return;
  return { intent: prior.intent, reason: simpleReason ? reason : prior.reason, productHint: null, policyQuery: null };
}

// 키 없이 실행하는 로컬 검증에서만 쓰는 의도 분류기.
export function fakeActionIntent(question: string): ActionIntent | undefined {
  const reason = reasonIn(question);
  const productHint = /재킷|자켓|팬츠|셔츠|바지/u.exec(question)?.[0] ?? null;
  if (reason === "missing_delivery" || /상담원.*(?:연결|상담|문의)|고객센터.*연결/u.test(question)) {
    return { intent: "support", reason: reason ?? "staff_requested", productHint, policyQuery: null };
  }
  if (/반품.*(?:해\s*줘|신청할래|신청하고 싶|접수하고 싶|할래|하려고|부탁)|돌려보내고 싶/u.test(question)) {
    return { intent: "return", reason, productHint, policyQuery: /반품비|배송비|수수료/u.test(question) ? "반품 배송비가 얼마예요?" : null };
  }
}
