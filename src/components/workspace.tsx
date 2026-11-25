"use client";

import Image from "next/image";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowUp, BookOpen, Check, ChevronDown, ChevronRight, FileText,
  Layers3, MessageSquare, Package, Plus, RotateCcw, Shirt, Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { categories, shops, showcaseShop, suggestions, type ActionDecision, type AgentAction, type AgentTool, type Answer, type CartResult, type CatalogResult, type Document, type OrderResult, type ProductDetail, type RequestKind, type RequestSummary, type ShopId } from "@/lib/demo";

import { progressLabels, type ChatEvent, type ProgressStage, type ReportProgress } from "@/lib/chat-progress";

type View = "chat" | "knowledge";
type Session = { sessionId: string; sessionToken: string };
type Turn = { id: string; question: string; decision?: ActionDecision; progress?: ProgressStage; result?: Answer; error?: string; finishing?: boolean };
type SavedMessage = {
  id: string; role: "assistant" | "user"; content: string; reply_to_id: string | null; client_request_id: string | null;
  source_refs: Answer["sources"]; abstained: boolean; catalog_response: Answer["catalog"]; tool_name: Answer["toolUsed"];
  order_response: Answer["orders"]; agent_response: Answer["action"]; agent_input: ActionDecision | null;
  cart_response?: Answer["cart"];
};
const sessionKey = (widget: string) => "shopops-chat:" + widget;

function savedTurns(messages: SavedMessage[]): Turn[] {
  const replies = new Map(messages.filter((row) => row.role === "assistant").map((row) => [row.reply_to_id, row]));
  return messages.filter((row) => row.role === "user" && replies.has(row.id)).map((row) => {
    const reply = replies.get(row.id)!;
    return { id: row.client_request_id ?? row.id, question: row.content, decision: row.agent_input ?? undefined,
      result: { answer: reply.content, sources: reply.source_refs, abstained: reply.abstained,
        catalog: reply.catalog_response, toolUsed: reply.tool_name, orders: reply.order_response, action: reply.agent_response,
        cart: reply.cart_response ?? undefined } };
  });
}
const shortcutIcons = { new: Package, returns: Undo2, shipping: Package, exchange: RotateCcw };
const minProgressMotionMs = 520;
const minStageDisplayMs = 280;
const searchExitMs = 140;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? "요청을 처리하지 못했어요.");
  return data as T;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function requestAnswer(options: RequestInit, report: ReportProgress): Promise<Answer> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/x-ndjson");
  const response = await fetch("/api/public/messages", { ...options, headers, cache: "no-store" });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/x-ndjson")) {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? "요청을 처리하지 못했어요.");
    return data as Answer;
  }

  if (!response.body) throw new Error("답변을 받지 못했어요. 다시 시도해 주세요.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line) as ChatEvent;
        if (event.type === "progress") report(event.stage);
        else if (event.type === "answer") return event.data;
        else if (event.type === "error") throw new Error(event.message);
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error("답변을 받는 중 연결이 끊겼어요. 다시 시도해 주세요.");
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><span className="brand-mark"><Layers3 size={19} /></span>{!compact && <span>ShopOps AI</span>}</div>;
}

export function Workspace() {
  const [view, setView] = useState<View>("chat");
  const [generation, setGeneration] = useState(0);
  const current = shops[showcaseShop];

  return <div className="workspace">
    <aside className="sidebar">
      <Brand />
      <div className="side-body">
        <nav aria-label="워크스페이스">
          <button className="nav-item" aria-current={view === "chat" ? "page" : undefined} onClick={() => setView("chat")}><MessageSquare size={17} /> 상담 테스트</button>
          <button className="nav-item" aria-current={view === "knowledge" ? "page" : undefined} onClick={() => setView("knowledge")}><BookOpen size={17} /> 지식베이스</button>
        </nav>
      </div>
      <span className="demo-label">데모</span>
    </aside>

    <div className="body-area">
      <header className="topbar">
        <div className="breadcrumbs"><strong>{current.name}</strong></div>
        {view === "chat" && <Button className="secondary new-chat" onClick={() => setGeneration((value) => value + 1)}><Plus size={15} /> 새 대화</Button>}
      </header>
      {view === "chat" ? <Chat key={generation} shop={showcaseShop} publicMode={false} catalogEnabled /> : <Knowledge shop={showcaseShop} />}
    </div>
  </div>;
}

export function PublicWidget({ widgetKey, name, catalogEnabled = false, customerEnabled = false }: { widgetKey: string; name: string; catalogEnabled?: boolean; customerEnabled?: boolean }) {
  const [generation, setGeneration] = useState(0);
  function resetChat() {
    if (customerEnabled) sessionStorage.removeItem(sessionKey(widgetKey));
    setGeneration((value) => value + 1);
  }

  return <div className="workspace public-workspace"><div className="body-area">
    <header className="topbar"><div className="breadcrumbs"><Brand compact /><strong>{name}</strong></div>
      <div className="chat-header-actions">
        {customerEnabled && <CustomerAccess onChange={resetChat} />}
        <Button className="secondary new-chat" onClick={resetChat}><Plus size={15} /> 새 대화</Button>
      </div>
    </header>
    <Chat key={generation} shop={showcaseShop} publicMode widgetKey={widgetKey} catalogEnabled={catalogEnabled} resume={customerEnabled} />
  </div></div>;
}

type DemoCustomer = "a" | "b" | null;
const demoChoices: { key: DemoCustomer; label: string }[] = [
  { key: null, label: "비로그인" }, { key: "a", label: "고객 A" }, { key: "b", label: "고객 B" },
];

// 시연용 합성 고객을 버튼으로 전환한다. 전환하면 새 대화를 연다.
// A·B가 아닌 고객으로 로그인돼 있으면 어느 버튼도 눌린 상태로 보이지 않고, 비로그인을 누르면 로그아웃한다.
type CustomerState = { loggedIn: boolean; customer: DemoCustomer };
function CustomerAccess({ onChange }: { onChange: () => void }) {
  const [state, setState] = useState<CustomerState | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    request<CustomerState>("/api/public/customer")
      .then((result) => { if (active) setState({ loggedIn: result.loggedIn, customer: result.customer ?? null }); })
      .catch(() => { if (active) setState({ loggedIn: false, customer: null }); });
    return () => { active = false; };
  }, []);

  const pressed = (key: DemoCustomer) => state !== undefined && (key === null ? !state.loggedIn : state.customer === key);

  async function choose(next: DemoCustomer) {
    if (!state || pressed(next)) return;
    setBusy(true);
    setError("");
    try {
      if (state.loggedIn) await request("/api/public/customer", json("POST", { action: "logout" }));
      setState({ loggedIn: false, customer: null });
      if (next) {
        const result = await request<CustomerState>("/api/public/customer", json("POST", { action: "demo", customer: next }));
        setState({ loggedIn: result.loggedIn, customer: result.customer ?? null });
      }
      onChange();
    } catch (error) {
      setError(error instanceof Error ? error.message : "고객 전환에 실패했어요.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="customer-access">
    <div className="customer-switch" role="group" aria-label="데모 고객 전환">
      {demoChoices.map((choice) => <button key={choice.label} type="button" aria-pressed={pressed(choice.key)}
        disabled={busy || state === undefined} onClick={() => void choose(choice.key)}>{choice.label}</button>)}
    </div>
    {error && <p className="error customer-error" role="alert">{error}</p>}
  </div>;
}

const toolLabels: Record<AgentTool, string> = {
  search_policies: "정책 검색",
  search_products: "상품 검색",
  get_order_status: "주문 조회",
  list_orders: "주문 내역",
  track_shipment: "택배 추적",
  check_return_eligibility: "반품 조건 확인",
  submit_return_request: "반품 접수",
  create_support_ticket: "상담 문의 접수",
  get_product: "상품 상세",
  view_cart: "장바구니",
  update_cart: "장바구니 변경",
  prepare_checkout: "주문 확인",
  place_order: "모의 결제 주문",
  list_addresses: "배송지 목록",
  prepare_order_change: "주문 변경 확인",
  change_order: "주문 변경",
  list_requests: "접수 내역",
  get_order_detail: "주문 상세",
};

function Chat({ shop, publicMode, widgetKey = shop, catalogEnabled, resume = false }: {
  shop: ShopId; publicMode: boolean; widgetKey?: string; catalogEnabled: boolean; resume?: boolean;
}) {
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [waiting, setWaiting] = useState(resume);
  const session = useRef<Session | null>(null);
  const active = useRef(true);
  const scrollbox = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const composerStart = useRef<number | null>(null);
  const latest = turns.at(-1);
  const lastAction = turns.findLast((turn) => turn.result?.action)?.id;

  useEffect(() => {
    active.current = true;
    let mounted = true;
    async function restore() {
      try {
        const stored = sessionStorage.getItem(sessionKey(widgetKey));
        if (!stored) return;
        const previous = JSON.parse(stored) as Session;
        const data = await request<{ messages: SavedMessage[] }>("/api/public/sessions/" + previous.sessionId + "/messages",
          { headers: { Authorization: "Bearer " + previous.sessionToken } });
        if (!mounted) return;
        session.current = previous;
        setTurns(savedTurns(data.messages));
      } catch {
        if (mounted) sessionStorage.removeItem(sessionKey(widgetKey));
      } finally {
        if (mounted) setWaiting(false);
      }
    }
    if (resume) void restore();
    return () => { mounted = false; active.current = false; };
  }, [resume, widgetKey]);

  useEffect(() => {
    if (turns.length) scrollbox.current?.scrollTo({ top: scrollbox.current.scrollHeight });
  }, [turns]);

  useLayoutEffect(() => {
    const element = composer.current;
    const start = composerStart.current;
    if (!element || start === null || !turns.length) return;
    composerStart.current = null;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const distance = start - element.getBoundingClientRect().top;
    if (Math.abs(distance) < 1) return;
    element.animate(
      [{ transform: `translateY(${distance}px)` }, { transform: "translateY(0)" }],
      { duration: 440, easing: "cubic-bezier(.2, .8, .2, 1)" },
    );
  }, [turns.length]);

  async function ask(question: string, retryId?: string, decision?: ActionDecision) {
    const cleaned = question.trim();
    if (!cleaned || waiting) return;
    if (!turns.length) composerStart.current = composer.current?.getBoundingClientRect().top ?? null;
    const id = retryId ?? crypto.randomUUID();
    const started = performance.now();
    let latestStageStarted = started;
    setInput("");
    setWaiting(true);
    const turn = { id, question: cleaned, decision };
    setTurns((list) => retryId ? list.map((item) => item.id === id ? turn : item) : [...list, turn]);
    try {
      session.current ??= await request<Session>("/api/public/sessions", json("POST", { publicWidgetKey: widgetKey }));
      if (!active.current) return;
      if (resume) sessionStorage.setItem(sessionKey(widgetKey), JSON.stringify(session.current));
      const options = json("POST", { sessionId: session.current.sessionId, clientRequestId: id,
        ...(decision ? { action: decision } : { content: cleaned }) });
      options.headers = { ...options.headers, Authorization: "Bearer " + session.current.sessionToken };
      const result = await requestAnswer(options, (progress) => {
        latestStageStarted = performance.now();
        setTurns((list) => list.map((turn) => turn.id === id ? { ...turn, progress } : turn));
      });
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const now = performance.now();
        const remaining = Math.max(minProgressMotionMs - (now - started), minStageDisplayMs - (now - latestStageStarted));
        if (remaining > 0) await wait(remaining);
        setTurns((list) => list.map((turn) => turn.id === id ? { ...turn, finishing: true } : turn));
        await wait(searchExitMs);
      }
      setTurns((list) => list.map((turn) => turn.id === id ? { ...turn, result, finishing: false } : turn));
    } catch (error) {
      setTurns((list) => list.map((turn) => turn.id === id ? { ...turn, error: error instanceof Error ? error.message : "다시 시도해 주세요." } : turn));
    } finally {
      setWaiting(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(input);
  }

  return <div className="chat-layout">
    <section className="chat-area" aria-label="고객 상담">
      <div className="conversation" ref={scrollbox}>
        {turns.length === 0 ? <div className="welcome">
          <div className="chat-emblem" aria-hidden="true"><Layers3 size={25} /></div>
          <h1>무엇을 도와드릴까요?</h1>
          <div className="suggestions">
            {suggestions.filter((item) => item.category !== "new" || catalogEnabled).map((item) => {
              const Icon = shortcutIcons[item.category];
              return <button className="suggestion" key={item.category} onClick={() => void ask(item.question)}>
                <Icon size={15} />
                <span>{item.title}</span>
              </button>;
            })}
          </div>
        </div> : <div className="turn-list" aria-live="polite">
          {turns.map((turn) => {
            return <article className="turn" key={turn.id}>
              <p className="user-message">{turn.question}</p>
              <div className="assistant-message">
                <span className="assistant-mark" aria-label="ShopOps AI" role="img"><Layers3 size={11} strokeWidth={1.75} /></span>
                <div className="assistant-content">
                  {turn.result ? <div className="assistant-answer">
                    <p className="assistant-copy">{turn.result.answer}</p>
                    {turn.result.toolUsed && <span className="tool-used" aria-label="사용한 도구">{toolLabels[turn.result.toolUsed]}</span>}
                    {turn.result.catalog && turn.result.action?.kind !== "checkout" && <ProductCards catalog={turn.result.catalog}
                      pick={waiting || !catalogEnabled ? undefined : (name, size) => void ask(`${name} ${size} 사이즈로 할게요`)} />}
                    {turn.result.product && <ProductDetailCard product={turn.result.product} />}
                    {turn.result.cart && turn.result.action?.kind !== "checkout" && <CartDetails cart={turn.result.cart} />}
                    {turn.result.orders && <OrderDetails result={turn.result.orders} />}
                    {turn.result.action && <ActionDetails action={turn.result.action} active={turn.id === lastAction} disabled={waiting}
                      choose={(value) => void ask(value)}
                      decide={(value) => void ask(decisionLabel(turn.result?.action, value), undefined, value)} />}
                    {turn.result.sources.length > 0 && <div className="reply-sources">
                      {turn.result.sources.map((source) => <details key={source.documentId} className="inline-source">
                        <summary>
                          <FileText size={14} /> {source.title} <span>v{source.version}</span>
                          <ChevronDown size={13} className="source-caret" aria-hidden="true" />
                        </summary>
                        <p>{source.excerpt}</p>
                      </details>)}
                    </div>}
                  </div> : turn.error ? <>
                    <p role="alert">{turn.error}</p>
                    <Button className="secondary" disabled={waiting} onClick={() => void ask(turn.question, turn.id, turn.decision)}>다시 시도</Button>
                  </> : <p className="pending" role="status" data-finishing={turn.finishing || undefined}>{progressLabels[turn.progress ?? "request"]}</p>}
                </div>
              </div>
            </article>;
          })}
        </div>}
      </div>
      <div className="composer-wrap" ref={composer}>
        <form className="composer" onSubmit={submit}>
          <input aria-label="질문" placeholder="질문을 입력하세요" value={input} onChange={(event) => setInput(event.target.value)} maxLength={2000} />
          <button className="send" aria-label="질문 보내기" disabled={waiting || !input.trim()}><ArrowUp size={18} /></button>
        </form>
      </div>
    </section>
    {!publicMode && <aside className="inspector" aria-label="답변 근거">
      <div className="inspector-head"><BookOpen size={17} /><h2>답변 근거</h2></div>
      {latest?.result?.sources.length ? latest.result.sources.map((source) => <div className="source-card" key={latest.id + source.documentId + source.version}>
        <div><FileText size={16} /><strong>{source.title}</strong><span>v{source.version}</span></div><p>{source.excerpt}</p>
      </div>) : latest?.result?.abstained && <p className="source-empty">일치하는 근거 없음</p>}
    </aside>}
  </div>;
}

const productCurrency = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });

const orderDate = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeZone: "Asia/Seoul" });
const scanDate = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Seoul" });

// 확인 카드 결정은 항상 같은 문장으로 보낸다. 재전송 시 서버가 같은 요청인지 문장으로 비교한다.
function decisionLabel(action: AgentAction | undefined, value: ActionDecision) {
  const confirm = value.decision === "confirm";
  if (action?.kind === "checkout") return confirm ? "주문 확인" : "주문 취소";
  if (action?.kind === "change") return confirm ? "변경 확인" : "변경 안 함";
  return confirm ? "접수 확인" : "접수 취소";
}

const changeTitles = { cancel: "주문 취소", address: "배송지 변경", exchange: "사이즈 교환" } as const;

function ActionDetails({ action, active, disabled, choose, decide }: {
  action: AgentAction; active: boolean; disabled: boolean; choose: (value: string) => void; decide: (value: ActionDecision) => void;
}) {
  const [condition, setCondition] = useState(false);
  if (action.kind === "closed") return null;
  if (action.kind === "receipt") return <p className="action-receipt"><Check size={15} aria-hidden="true" />{action.action === "checkout"
    ? <span>주문번호 <strong>{action.orders?.join(", ")}</strong> · 모의 결제</span>
    : <span>{action.action in changeTitles ? changeTitles[action.action as keyof typeof changeTitles] + " · " : ""}접수번호 <strong>{action.id}</strong></span>}</p>;
  if (action.kind === "addresses") return <ul className="order-history" aria-label="배송지 선택">
    {action.items.map((place) => <li className="order-row" key={place.id}>
      <button type="button" className="order-choice" disabled={!active || disabled} onClick={() => choose(place.label + " 배송지로 바꿔줘")}>
        <span><strong>{place.label}{place.isDefault && " · 기본"}</strong><small>{place.summary}</small></span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    </li>)}
  </ul>;
  if (action.kind === "change") {
    const exchange = action.change === "exchange";
    return <section className="shipment-card action-card" aria-label={changeTitles[action.change]}>
      <div className="shipment-heading"><strong>{changeTitles[action.change]}</strong><span>{action.order.status}</span></div>
      <p className="shipment-meta">{action.order.reference} · {action.order.name} · {action.order.quantity}개</p>
      {action.change === "address" && <p className="shipment-meta">새 배송지: {action.detail.label} · {action.detail.summary}</p>}
      {exchange && <p className="shipment-meta">{action.detail.fromSize ?? "기존"} → {action.detail.size}</p>}
      {action.change === "cancel" && <p className="shipment-meta">출고 전 주문이라 바로 취소돼요.</p>}
      {active && <>
        {exchange && <label className="action-check"><input type="checkbox" checked={condition} disabled={disabled}
          onChange={(event) => setCondition(event.target.checked)} /> 미사용 상품이며 태그가 부착돼 있어요.</label>}
        <div className="action-buttons">
          <Button className="primary" disabled={disabled || exchange && !condition}
            onClick={() => decide({ approvalId: action.id, decision: "confirm", itemConditionConfirmed: condition })}>
            {action.change === "cancel" ? "주문 취소하기" : action.change === "address" ? "배송지 바꾸기" : "교환 신청"}</Button>
          <Button className="secondary" disabled={disabled}
            onClick={() => decide({ approvalId: action.id, decision: "cancel", itemConditionConfirmed: false })}>닫기</Button>
        </div>
      </>}
    </section>;
  }
  if (action.kind === "checkout") return <section className="shipment-card action-card" aria-label="주문 확인">
    <div className="shipment-heading"><strong>주문 확인</strong><span>모의 결제</span></div>
    <CartLines cart={action.cart} />
    {active && <div className="action-buttons">
      <Button className="primary" disabled={disabled}
        onClick={() => decide({ approvalId: action.id, decision: "confirm", itemConditionConfirmed: false })}>
        {productCurrency.format(action.cart.total)} 주문하기</Button>
      <Button className="secondary" disabled={disabled}
        onClick={() => decide({ approvalId: action.id, decision: "cancel", itemConditionConfirmed: false })}>취소</Button>
    </div>}
  </section>;
  if (action.kind === "return_reason") return active ? <div className="action-buttons">
    {["단순 변심", "상품 파손", "오배송"].map((reason) => <Button className="secondary" key={reason} disabled={disabled} onClick={() => choose(reason)}>{reason}</Button>)}
  </div> : null;
  if (action.kind === "select_order") return <ul className="order-history" aria-label="주문 선택">
    {action.items.map((order) => <li className="order-row" key={order.reference}>
      <button type="button" className="order-choice" disabled={!active || disabled} onClick={() => choose(order.reference)}>
        <span><strong>{order.name}</strong><small>{order.reference} · {orderDate.format(new Date(order.orderedAt))}</small></span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    </li>)}
  </ul>;
  const isReturn = action.action === "return";
  const confirmLabel = isReturn ? "반품 접수" : "상담 문의 접수";
  return <section className="shipment-card action-card" aria-label={confirmLabel}>
    <div className="shipment-heading"><strong>{confirmLabel}</strong><span>{action.reason}</span></div>
    {action.order && <p className="shipment-meta">{action.order.reference} · {action.order.name}{action.quantity && " · " + action.quantity + "개"}</p>}
    {isReturn && action.fee !== null && <p className="shipment-meta">반품비 {productCurrency.format(action.fee)}</p>}
    {active && <>
      {isReturn ? <label className="action-check"><input type="checkbox" checked={condition} disabled={disabled}
        onChange={(event) => setCondition(event.target.checked)} /> 미사용 상품이며 태그와 구성품이 모두 있어요.</label>
        : <p className="shipment-meta">상담팀에 주문 정보와 이 대화가 전달됩니다.</p>}
      <div className="action-buttons">
        <Button className="primary" disabled={disabled || isReturn && !condition}
          onClick={() => decide({ approvalId: action.id, decision: "confirm", itemConditionConfirmed: condition })}>{confirmLabel}</Button>
        <Button className="secondary" disabled={disabled}
          onClick={() => decide({ approvalId: action.id, decision: "cancel", itemConditionConfirmed: false })}>취소</Button>
      </div>
    </>}
  </section>;
}

const returnStatus = {
  eligible: "반품 가능",
  not_delivered: "배송 완료 전",
  too_late: "반품 기한 지남",
  already_submitted: "반품 접수됨",
  review: "상담원 확인 필요",
  canceled: "주문 취소됨",
};

const requestKinds: Record<RequestKind, string> = { return: "반품", exchange: "교환", cancel: "주문 취소", address: "배송지 변경", ticket: "상담 문의" };
// 반품 사유와 상담 문의 사유. DB에는 코드로 저장된다.
const requestReasons: Record<string, string> = { change_of_mind: "단순 변심", damaged: "상품 파손·하자", wrong_item: "오배송",
  missing_delivery: "배송 완료 미수령", policy_review: "반품 조건 검토", staff_requested: "상담원 문의", customer_request: "고객 요청" };

function RequestRows({ items, label }: { items: RequestSummary[]; label: string }) {
  return <ul className="order-history" aria-label={label}>
    {items.map((item) => <li className="order-row" key={item.id}>
      <div><strong>{requestKinds[item.kind]}{item.name ? " · " + item.name : ""}</strong><span>{item.status}</span></div>
      <p>{[item.reference, orderDate.format(new Date(item.createdAt)) + " 접수",
        item.kind === "ticket" || item.kind === "return" ? (item.detail ? requestReasons[item.detail] ?? item.detail : null) : item.detail,
        item.fee !== null ? "반품비 " + productCurrency.format(item.fee) : null].filter(Boolean).join(" · ")}</p>
    </li>)}
  </ul>;
}

function OrderDetails({ result }: { result: OrderResult }) {
  if (result.kind === "requests") {
    return result.items.length ? <RequestRows items={result.items} label="접수 내역" /> : null;
  }
  if (result.kind === "detail") {
    const { order, info } = result;
    return <section className="shipment-card" aria-label="주문 상세">
      <div className="shipment-heading"><strong>{order.name}</strong><span>{order.status}</span></div>
      <p className="shipment-meta">{order.reference} · {orderDate.format(new Date(order.orderedAt))} 주문</p>
      <dl className="order-detail">
        <div><dt>사이즈·수량</dt><dd>{(info.size ?? "기록 없음") + " · " + order.quantity + "개"}</dd></div>
        <div><dt>결제 금액</dt><dd>{info.paidTotal !== null ? productCurrency.format(info.paidTotal) : "기록 없음"}</dd></div>
        <div><dt>결제 수단</dt><dd>{info.paymentMethod ?? "기존 주문(모의)"}</dd></div>
        <div><dt>배송지</dt><dd>{info.address ?? "기록 없음"}</dd></div>
      </dl>
      {result.requests.length > 0 && <RequestRows items={result.requests} label="이 주문의 접수 내역" />}
    </section>;
  }
  if (result.kind !== "shipment") {
    if (result.items.length === 0) return null;
    return <ul className="order-history" aria-label={result.kind === "history" ? "최근 주문 내역" : "주문별 반품 가능 여부"}>
      {result.items.map((order) => <li className="order-row" key={order.reference}>
        <div><strong>{order.name}</strong><span>{("eligibility" in order) ? returnStatus[order.eligibility] : order.status}</span></div>
        <p>{order.reference} · {orderDate.format(new Date(order.orderedAt))} · {order.quantity}개
          {order.total !== null && " · " + productCurrency.format(order.total)}</p>
      </li>)}
    </ul>;
  }

  return <section className="shipment-card" aria-label="택배 이동 내역">
    <div className="shipment-heading"><strong>{result.order.name}</strong><span>{result.order.status}</span></div>
    <p className="shipment-meta">{[result.order.reference, result.carrier, result.trackingNumber].filter(Boolean).join(" · ")}</p>
    {result.events.length > 0 && <ol className="shipment-events">
      {result.events.map((event, index) => <li key={event.occurredAt} data-latest={index === 0}>
        <strong>{event.location} · {event.description}</strong>
        <span>{scanDate.format(new Date(event.occurredAt))}</span>
      </li>)}
    </ol>}
    <p className="shipment-meta">모의 택배 기록 · 마지막 스캔 기준</p>
  </section>;
}

function CartLines({ cart }: { cart: CartResult }) {
  return <>
    <ul className="cart-lines">
      {cart.lines.map((line) => <li key={line.productId + line.size}>
        <span>{line.name} · {line.size} · {line.quantity}개</span><span>{productCurrency.format(line.lineTotal)}</span>
      </li>)}
    </ul>
    <p className="shipment-meta">상품 {productCurrency.format(cart.subtotal)} · 배송비 {cart.shippingFee ? productCurrency.format(cart.shippingFee) : "무료"}</p>
    <p className="cart-total"><span>결제 금액</span><strong>{productCurrency.format(cart.total)}</strong></p>
  </>;
}

function CartDetails({ cart }: { cart: CartResult }) {
  if (!cart.lines.length) return null;
  return <section className="shipment-card action-card" aria-label="장바구니">
    <div className="shipment-heading"><strong>장바구니</strong><span>{cart.lines.length}개 상품</span></div>
    <CartLines cart={cart} />
  </section>;
}

function ProductDetailCard({ product }: { product: ProductDetail }) {
  return <section className="shipment-card action-card" aria-label="상품 상세">
    <div className="shipment-heading"><strong>{product.name}</strong><span>{productCurrency.format(product.price)}</span></div>
    <p className="shipment-meta">{product.material} · {product.fit}</p>
    <p className="shipment-meta">관리: {product.care}</p>
    <ul className="product-options" aria-label="사이즈 및 재고">
      {product.options.map((option) => <li key={option.size} data-available={option.stock > 0}>
        {option.size}{option.stock > 0 ? "" : " 품절"}
      </li>)}
    </ul>
  </section>;
}

function ProductCards({ catalog, pick }: { catalog: CatalogResult; pick?: (name: string, size: string) => void }) {
  if (!catalog.products.length) return null;

  return <ul className="product-grid" aria-label="추천 상품">
    {catalog.products.map((product) => <li className="product-card" key={product.id}>
      {product.image ? <Image className="product-image" src={product.image} alt={product.name} width={384} height={384} sizes="(max-width: 620px) 45vw, 210px" />
        : <div className="product-image product-image-empty" role="img" aria-label={product.name + " 이미지 준비 중"}><Shirt size={22} strokeWidth={1.5} aria-hidden="true" /></div>}
      <div className="product-details">
        <h3>{product.name}</h3>
        <strong>{productCurrency.format(product.price)}</strong>
        <p>{product.color}</p>
        <ul className="product-options" aria-label="사이즈 및 재고">
          {product.options.map((option) => <li key={option.size} data-available={option.available}>
            {option.available && pick
              ? <button type="button" className="size-pick" aria-label={`${product.name} ${option.size} 선택`}
                onClick={() => pick(product.name, option.size)}>{option.size}</button>
              : <>{option.size}{!option.available && " 품절"}</>}
          </li>)}
        </ul>
      </div>
    </li>)}
  </ul>;
}

function Knowledge({ shop }: { shop: ShopId }) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [selected, setSelected] = useState<string>();
  const [edited, setEdited] = useState("");
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const current = documents.find((document) => document.id === selected);

  useEffect(() => {
    let active = true;
    request<{ documents: Document[] }>("/api/demo/knowledge?shop=" + shop).then(({ documents }) => {
      if (!active) return;
      setDocuments(documents);
      setSelected(documents[0]?.id);
      setEdited(documents[0]?.content ?? "");
    }).catch((error: unknown) => {
      if (active) setError(error instanceof Error ? error.message : "문서를 불러오지 못했어요.");
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [shop]);

  async function change(method: "PATCH" | "POST") {
    if (!current || busy) return;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const data = { shop, id: current.id, version: current.version };
      const { document } = await request<{ document: Document }>("/api/demo/knowledge", json(method, method === "PATCH" ? { ...data, content: edited } : data));
      setDocuments((list) => list.map((item) => item.id === document.id ? document : item));
      setEdited(document.content);
      setNotice(method === "PATCH" ? "저장됨 · 인덱싱 필요" : "인덱싱 완료");
    } catch (error) {
      setError(error instanceof Error ? error.message : "문서를 처리하지 못했어요.");
    } finally { setBusy(false); }
  }

  const dirty = current?.content !== edited;
  return <main className="knowledge enter">
    <div className="knowledge-header"><h1>지식베이스</h1></div>
    <div className="knowledge-grid">
      <section className="document-list" aria-label="정책 문서">
        <h2>정책 문서 <span>{documents.length}</span></h2>
        {documents.map((doc) => <button key={doc.id} disabled={busy} aria-pressed={selected === doc.id} onClick={() => {
          setSelected(doc.id); setEdited(doc.content); setNotice(""); setError("");
        }}><FileText size={16} /><span><strong>{doc.title}</strong><small>{categories[doc.category]} · v{doc.version}</small></span><ChevronRight size={15} /></button>)}
      </section>
      <section className="editor" aria-label="문서 편집">
        {current ? <>
          <div className="editor-head"><h2>{current.title}</h2><span className={"status " + current.status}>{current.status === "ready" ? "검색 가능" : "인덱싱 필요"}</span></div>
          <label htmlFor="policy">정책 본문</label>
          <textarea id="policy" maxLength={10000} value={edited} disabled={busy} onChange={(event) => setEdited(event.target.value)} />
          <div className="editor-actions">
            <Button className="secondary" disabled={busy || dirty || current.status === "ready"} onClick={() => void change("POST")}><RotateCcw size={15} /> 다시 인덱싱</Button>
            <Button className="primary" disabled={busy || !dirty || !edited.trim()} onClick={() => void change("PATCH")}><Check size={16} /> 변경사항 저장</Button>
          </div>
        </> : <p>{busy ? "불러오는 중" : "문서 없음"}</p>}
        {notice && <p role="status" className="notice">{notice}</p>}
        {error && <p role="alert" className="error">{error}</p>}
      </section>
    </div>
  </main>;
}
