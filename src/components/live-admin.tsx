"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ExternalLink, Layers3, LogOut, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

type Tenant = { id: string; name: string; slug: string; public_widget_key: string };
type Policy = { id: string; title: string; content: string; kind: "faq" | "markdown"; version: number; index_status: string };
type Session = { id: string; created_at: string };
type Message = { id: string; role: string; content: string };
type Ticket = { id: string; session_id: string; title: string; reason: string | null; order_reference: string | null;
  last_scan: { at: string; location: string; description: string } | null; created_at: string };
const ticketReasons: Record<string, string> = { damaged: "상품 파손·하자", wrong_item: "오배송", missing_delivery: "배송 완료 후 미수령",
  policy_review: "반품 조건 검토", staff_requested: "상담원 문의" };
type Draft = Pick<Policy, "title" | "content" | "kind">;
const empty: Draft = { title: "", content: "", kind: "faq" };

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, { method, cache: "no-store", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error?.message ?? "요청을 완료하지 못했어요.", { cause: res.status });
  return result as T;
}

function label(error: unknown) {
  return error instanceof Error ? error.message : "요청을 완료하지 못했어요.";
}

export function LiveAdmin() {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [active, setActive] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const tenant = tenants?.find((item) => item.id === active) ?? tenants?.[0];

  useEffect(() => {
    let current = true;
    api<{ tenants: Tenant[] }>("/api/tenants").then(({ tenants }) => {
      if (current) setTenants(tenants);
    }).catch((error: unknown) => {
      if (current && (!(error instanceof Error) || error.cause !== 401)) setError(label(error));
    }).finally(() => { if (current) setLoaded(true); });
    return () => { current = false; };
  }, []);

  async function perform(action: () => Promise<void>) {
    setError(""); setNotice(""); setBusy(true);
    try { await action(); } catch (error) { setError(label(error)); }
    finally { setBusy(false); }
  }

  function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") || "login";
    void perform(async () => {
      const state = await api<{ loggedIn: boolean }>("/api/admin/auth", "POST", { action, email: data.get("email"), password: data.get("password") });
      if (!state.loggedIn) { setNotice("인증 메일을 확인하고 로그인해 주세요."); return; }
      setTenants((await api<{ tenants: Tenant[] }>("/api/tenants")).tenants);
    });
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void perform(async () => {
      const created = await api<Tenant>("/api/tenants", "POST", { name: data.get("name"), slug: data.get("slug") });
      setTenants((list) => [...(list ?? []), created]);
      setActive(created.id);
      form.reset();
    });
  }

  return <div className="live-workspace">
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Layers3 size={19} /></span>ShopOps AI</div>
      {tenants && <Button className="secondary" disabled={busy} onClick={() => void perform(async () => {
        await api("/api/admin/auth", "POST", { action: "logout" });
        setTenants(null); setActive("");
      })}><LogOut size={15} /> 로그아웃</Button>}
    </header>
    <main className="knowledge live-content">
      {!loaded ? <p>작업공간을 불러오는 중이에요.</p> : tenants === null ? <form className="editor auth-form" onSubmit={authenticate}>
        <h1>관리자 로그인</h1>
        <label>이메일<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
        <label>비밀번호<input name="password" type="password" autoComplete="current-password" minLength={8} maxLength={128} required /></label>
        <div className="editor-actions"><Button className="secondary" name="action" value="signup" type="submit" disabled={busy}>가입</Button><Button className="primary" name="action" value="login" type="submit" disabled={busy}>로그인</Button></div>
      </form> : <>
        <div className="knowledge-header"><h1>쇼핑몰 관리</h1></div>
        <div className="live-controls">
          {tenant && <>
            {tenants.length > 1 ? <label>쇼핑몰 <select value={tenant.id} onChange={(event) => setActive(event.target.value)}>{tenants.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : <strong>{tenant.name}</strong>}
            <a className="button secondary" href={"/chat/" + tenant.public_widget_key} target="_blank" rel="noreferrer"><ExternalLink size={15} /> 공개 상담 열기</a>
          </>}
          <details className="live-add"><summary>쇼핑몰 추가</summary><form onSubmit={create}>
            <label>쇼핑몰 이름<input name="name" required minLength={2} maxLength={120} /></label>
            <label>쇼핑몰 슬러그<input name="slug" required pattern="[a-z0-9][a-z0-9\-]{2,49}" title="영문 소문자, 숫자, 하이픈 3~50자" /></label>
            <Button className="primary" type="submit" disabled={busy}><Plus size={15} /> 생성</Button>
          </form></details>
        </div>
        {tenant ? <TenantPanel key={tenant.id} tenant={tenant} /> : <p>등록된 쇼핑몰 없음</p>}
      </>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  </div>;
}

function TenantPanel({ tenant }: { tenant: Tenant }) {
  const root = "/api/tenants/" + tenant.id;
  const route = root + "/documents";
  const [docs, setDocs] = useState<Policy[]>([]);
  const [selected, setSelected] = useState<Policy | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [session, setSession] = useState("");
  const [page, setPage] = useState(1);
  const [view, setView] = useState<"documents" | "conversations" | "tickets">("documents");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [ticketPage, setTicketPage] = useState(1);

  useEffect(() => {
    let alive = true;
    api<{ documents: Policy[] }>(route + "?page=" + page).then(({ documents }) => {
      if (alive) setDocs(documents);
    }).catch((error: unknown) => { if (alive) setError(label(error)); });
    return () => { alive = false; };
  }, [page, route]);

  function choose(document: Policy | null) {
    setSelected(document); setDraft(document ?? empty); setError("");
  }

  async function run(callback: () => Promise<void>) {
    setBusy(true); setError("");
    try { await callback(); } catch (error) { setError(label(error)); }
    finally { setBusy(false); }
  }

  async function refreshDocuments(id?: string) {
    const { documents } = await api<{ documents: Policy[] }>(route + "?page=" + page);
    setDocs(documents);
    choose(documents.find((document) => document.id === id) ?? null);
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      const details = { title: draft.title, content: draft.content, kind: draft.kind };
      const result = selected
        ? await api<{ id: string }>(route + "/" + selected.id, "PATCH", { ...details, expectedVersion: selected.version })
        : await api<{ id: string }>(route, "POST", details);
      await refreshDocuments(result.id);
    });
  }

  function editIndex(remove: boolean) {
    if (!selected) return;
    if (remove && !window.confirm("이 정책 문서를 삭제할까요?")) return;
    void run(async () => {
      await api(route + "/" + selected.id + (remove ? "" : "/index"), remove ? "DELETE" : "POST", { expectedVersion: selected.version });
      await refreshDocuments(remove ? undefined : selected.id);
    });
  }

  function openConversations() {
    setView("conversations");
    void run(async () => setSessions((await api<{ sessions: Session[] }>(root + "/conversations")).sessions));
  }

  function openTickets(nextPage = 1) {
    setView("tickets");
    void run(async () => {
      setTickets((await api<{ tickets: Ticket[] }>(root + "/support-tickets?page=" + nextPage)).tickets);
      setTicketPage(nextPage);
      setSelectedTicket(null);
    });
  }

  async function loadConversation(id: string) {
    const result = await api<{ messages: Message[] }>(root + "/conversations/" + id);
    setMessages(result.messages);
    setSession(id);
  }

  const conversation = messages.length ? messages.map((message) => <p key={message.id} className="live-message">
    <strong>{message.role === "user" ? "고객" : "AI"}</strong> {message.content}
  </p>) : <p>메시지가 없어요.</p>;

  return <>
    <nav className="live-tabs" aria-label="쇼핑몰 관리">
      <Button className={view === "documents" ? "primary" : "secondary"} onClick={() => setView("documents")}>정책 문서</Button>
      <Button className={view === "conversations" ? "primary" : "secondary"} onClick={openConversations}>상담 이력</Button>
      <Button className={view === "tickets" ? "primary" : "secondary"} disabled={busy} onClick={() => openTickets()}>상담 문의</Button>
    </nav>
    {view === "documents" ? <div className="knowledge-grid">
      <section className="document-list" aria-label="정책 목록">
        <button type="button" onClick={() => choose(null)} disabled={busy}><Plus size={16} /> 정책 추가</button>
        {docs.map((document) => <button key={document.id} aria-pressed={selected?.id === document.id} disabled={busy} onClick={() => choose(document)}>{document.title}</button>)}
        <div className="editor-actions"><Button className="secondary" disabled={page <= 1 || busy} onClick={() => { choose(null); setPage(page - 1); }}>이전</Button><Button className="secondary" disabled={docs.length < 20 || busy} onClick={() => { choose(null); setPage(page + 1); }}>다음</Button></div>
      </section>
      <form className="editor" onSubmit={save}>
        <div className="editor-head"><h2>{selected ? "정책 편집" : "새 정책"}</h2>{selected && <span className={"status " + selected.index_status}>{selected.index_status === "ready" ? "검색 가능" : "인덱싱 필요"} · v{selected.version}</span>}</div>
        <label>제목<input required maxLength={200} value={draft.title} disabled={busy} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <label>형식<select value={draft.kind} disabled={busy} onChange={(event) => setDraft({ ...draft, kind: event.target.value as Draft["kind"] })}><option value="faq">FAQ</option><option value="markdown">Markdown</option></select></label>
        <label>정책 본문<textarea required maxLength={10000} value={draft.content} disabled={busy} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>
        <div className="editor-actions">
          {selected && <Button className="secondary" disabled={busy} onClick={() => editIndex(true)}>삭제</Button>}
          {selected && <Button className="secondary" disabled={busy || selected.index_status === "ready"} onClick={() => editIndex(false)}><RefreshCw size={14} /> 인덱싱</Button>}
          <Button className="primary" disabled={busy} type="submit">저장</Button>
        </div>
      </form>
    </div> : view === "conversations" ? <div className="knowledge-grid">
      <section className="document-list" aria-label="상담 목록">{sessions.length ? sessions.map((item) => <button key={item.id} aria-pressed={session === item.id} disabled={busy} onClick={() => void run(() => loadConversation(item.id))}>{new Date(item.created_at).toLocaleString("ko-KR")}</button>) : <p>아직 상담이 없어요.</p>}</section>
      <section className="editor" aria-label="상담 메시지">{session ? conversation : <p>상담을 선택해 주세요.</p>}</section>
    </div> : <div className="knowledge-grid">
      <section className="document-list" aria-label="접수된 상담 문의">
        {tickets.length ? tickets.map((ticket) => <button key={ticket.id} aria-pressed={selectedTicket?.id === ticket.id} disabled={busy}
          onClick={() => void run(async () => { await loadConversation(ticket.session_id); setSelectedTicket(ticket); })}>
          {ticketReasons[ticket.reason ?? ""] ?? ticket.title}{ticket.order_reference && " · " + ticket.order_reference}
        </button>) : <p>접수된 문의가 없어요.</p>}
        <div className="editor-actions">
          <Button className="secondary" disabled={ticketPage === 1 || busy} onClick={() => openTickets(ticketPage - 1)}>이전</Button>
          <Button className="secondary" disabled={tickets.length < 20 || busy} onClick={() => openTickets(ticketPage + 1)}>다음</Button>
        </div>
      </section>
      <section className="editor" aria-label="상담 문의 상세">{selectedTicket ? <>
        <h2>{ticketReasons[selectedTicket.reason ?? ""] ?? selectedTicket.title}</h2>
        <p>{selectedTicket.id} · {new Date(selectedTicket.created_at).toLocaleString("ko-KR")}</p>
        {selectedTicket.last_scan && <p>마지막 배송 기록 · {selectedTicket.last_scan.location} · {selectedTicket.last_scan.description}
          {" · " + new Date(selectedTicket.last_scan.at).toLocaleString("ko-KR")}</p>}
        {selectedTicket.session_id === session && conversation}
      </> : <p>상담 문의를 선택해 주세요.</p>}</section>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
  </>;
}
