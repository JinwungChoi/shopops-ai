import "server-only";
import { DemoError, createToken, explain, hashToken } from "./demo-core";
import type { ReportProgress } from "@/lib/chat-progress";
import type { ActionDecision, Answer } from "@/lib/demo";
import { catalogAnswer, catalogQuery, readCatalogFilters, styleCatalogWidget, type CatalogFilters } from "./catalog";
import { embeddings } from "./embeddings";
import { generate, generatePolicyPart } from "./generation";
import { customerClient, serverClient } from "./supabase";
import { searchPolicies } from "./policy-search";
import { answerInquiry, presentedOrders } from "./agent-inquiry";
import { listReturnEligibility, orderLoginRequired } from "./mock-orders";
import { agentStateSchema, fakeActionIntent, followUpIntent, isReturnableOrderListQuestion, orderReference, reportedMissingDelivery, type ActionIntent, type AgentState } from "./agent-intent";
import { runAgentWorkflow } from "./agent-workflow";

async function budget(scope: string, limit: number) {
  const { data, error } = await serverClient().rpc("take_request_budget", { p_scope_hash: hashToken(scope), p_limit: limit });
  if (error) throw new DemoError(503, "일시적으로 상담을 시작할 수 없어요.");
  if (!data) throw new DemoError(429, "요청이 많아요. 잠시 후 다시 시도해 주세요.");
}

export async function createSession(widgetKey: string) {
  const client = serverClient();
  await budget("session:global", 80);
  const { data: tenant, error } = await client.from("tenants").select("id")
    .eq("public_widget_key", widgetKey).eq("is_active", true).maybeSingle();
  if (error) throw new DemoError(503, "상담을 시작하지 못했어요.");
  if (!tenant) throw new DemoError(404, "쇼핑몰을 찾을 수 없어요.");
  await budget("widget:" + tenant.id, 30);
  const customer = widgetKey === styleCatalogWidget ? (await (await customerClient()).auth.getUser()).data.user : null;
  const token = createToken();
  const expiresAt = new Date(Date.now() + 1800_000).toISOString();
  const { data, error: insertError } = await client.from("chat_sessions").insert({
    tenant_id: tenant.id, token_hash: hashToken(token), expires_at: expiresAt, customer_user_id: customer?.id ?? null,
  }).select("id").single();
  if (insertError) throw new DemoError(503, "상담을 시작하지 못했어요.");
  return { sessionId: data.id as string, sessionToken: token, expiresAt };
}

async function validSession(id: string, token: string) {
  const client = serverClient();
  const { data, error } = await client.from("chat_sessions").select("id,tenant_id,customer_user_id,tenants!inner(is_active,public_widget_key)")
    .eq("id", id).eq("token_hash", hashToken(token)).gt("expires_at", new Date().toISOString())
    .eq("tenants.is_active", true).is("revoked_at", null).maybeSingle();
  if (error) throw new DemoError(503, "상담 세션을 확인하지 못했어요.");
  if (!data) throw new DemoError(401, "대화가 만료됐어요. 새 대화를 시작해 주세요.");
  const customerId = typeof data.customer_user_id === "string" ? data.customer_user_id : undefined;
  if (customerId) {
    const { data: auth, error: authError } = await (await customerClient()).auth.getUser();
    if (authError || auth.user?.id !== customerId) throw new DemoError(401, "이 고객 상담을 보려면 다시 로그인해 주세요.");
  }
  const tenant: unknown = data.tenants;
  const catalogEnabled = typeof tenant === "object" && tenant !== null &&
    "public_widget_key" in tenant && tenant.public_widget_key === styleCatalogWidget;
  return { client, tenantId: String(data.tenant_id), sessionId: String(data.id), catalogEnabled, customerId };
}

export async function history(sessionId: string, token: string, offset: number) {
  const session = await validSession(sessionId, token);
  const { data, error } = await session.client.from("chat_messages").select("id,role,content,source_refs,abstained,created_at,reply_to_id,client_request_id,catalog_response,tool_name,order_response,agent_response,agent_input,cart_response")
    .eq("tenant_id", session.tenantId).eq("session_id", session.sessionId)
    .order("created_at").order("id").range(offset, offset + 49);
  if (error) throw new DemoError(502, "대화 내역을 읽지 못했어요.");
  return data;
}

export async function answerMessage(sessionId: string, token: string, requestId: string, question: string, report?: ReportProgress, action?: ActionDecision) {
  const { client, tenantId, sessionId: authorized, catalogEnabled, customerId } = await validSession(sessionId, token);
  if (action && (!catalogEnabled || !customerId)) throw new DemoError(401, "접수하려면 데모 고객으로 로그인해 주세요.");
  await budget("answer:session:" + authorized, 12);
  await budget("answer:tenant:" + tenantId, 35);
  await budget("answer:global", 100);

  const { data: message, error: insertError } = await client.from("chat_messages").insert({
    tenant_id: tenantId, session_id: authorized, role: "user", content: question, client_request_id: requestId, agent_input: action ?? null,
  }).select("id").single();
  if (insertError?.code === "23505") {
    const { data: prior } = await client.from("chat_messages").select("id,content,agent_input")
      .eq("tenant_id", tenantId).eq("session_id", authorized).eq("role", "user").eq("client_request_id", requestId).maybeSingle();
    if (!prior || prior.content !== question || (action
      ? prior.agent_input?.approvalId !== action.approvalId || prior.agent_input?.decision !== action.decision ||
        prior.agent_input?.itemConditionConfirmed !== action.itemConditionConfirmed
      : prior.agent_input !== null)) throw new DemoError(409, "요청 내용이 이전과 달라요.");
    const { data: answer } = await client.from("chat_messages").select("id,content,source_refs,abstained,catalog_response,tool_name,order_response,agent_response,cart_response")
      .eq("tenant_id", tenantId).eq("session_id", authorized).eq("reply_to_id", prior.id).maybeSingle();
    if (!answer) throw new DemoError(409, "이전 요청을 처리하고 있어요.");
    return { messageId: answer.id, answer: answer.content, sources: answer.source_refs, abstained: answer.abstained,
      ...(answer.catalog_response && { catalog: answer.catalog_response }), ...(answer.tool_name && { toolUsed: answer.tool_name }),
      ...(answer.order_response && { orders: answer.order_response }), ...(answer.agent_response && { action: answer.agent_response }),
      ...(answer.cart_response && { cart: answer.cart_response }) };
  }
  if (insertError) throw new DemoError(502, "질문을 저장하지 못했어요.");

  try {
    let filters: CatalogFilters | undefined;
    let result: Answer | undefined;
    let checkpoint: AgentState | undefined;
    let workflowPolicy: Answer | undefined;
    async function policyAnswer(queryText: string, prompt: string, policyPart = false) {
      report?.("search_policies");
      const adapter = embeddings();
      const [query] = await adapter.embed([queryText]);
      if (!query) throw new DemoError(502, "검색용 임베딩을 확인하지 못했어요.");
      const { evidence } = await searchPolicies(client, tenantId, adapter.model, query);
      if (evidence.length) report?.("compose");
      return policyPart ? generatePolicyPart(prompt, queryText, evidence) : generate(prompt, evidence);
    }
    if (catalogEnabled) {
      const recent = () => client.from("chat_messages").select("catalog_filters,agent_state,order_response")
        .eq("tenant_id", tenantId).eq("session_id", authorized).eq("role", "assistant")
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1);
      const [catalog, workflow, shipment, displayed, lately] = await Promise.all([
        recent().not("catalog_filters", "is", null).maybeSingle(),
        recent().not("agent_state", "is", null).maybeSingle(),
        recent().eq("order_response->>kind", "shipment").maybeSingle(),
        recent().not("order_response", "is", null).maybeSingle(),
        // 직전 대화 몇 줄만 모델에 넘긴다. 사이즈만 답하는 후속 질문이 앞의 요청을 이어받게 하기 위해서다.
        client.from("chat_messages").select("role,content").eq("tenant_id", tenantId).eq("session_id", authorized)
          .neq("id", message.id).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(4),
      ]);
      if (catalog.error || workflow.error || shipment.error || displayed.error || lately.error) throw new DemoError(502, "이전 상담 내용을 확인하지 못했어요.");
      const recentTurns = lately.data.reverse().map((row) => ({
        role: row.role === "user" ? "customer" as const : "assistant" as const, text: String(row.content).slice(0, 300) }));
      const previousFilters = readCatalogFilters(catalog.data?.catalog_filters);
      const prior = agentStateSchema.safeParse(workflow.data?.agent_state).data;
      const lastOrder = presentedOrders(shipment.data?.order_response)[0]?.reference;
      const live = process.env.SHOP_OPS_LIVE_MODEL === "1";
      let intent: ActionIntent | undefined = action ? undefined : followUpIntent(question, prior);

      const returnEligibility = async (hint: string | null) => {
        if (!customerId) return orderLoginRequired("check_return_eligibility");
        report?.("check_return_eligibility");
        const product = hint && question.toLowerCase().includes(hint.toLowerCase()) ? hint.replaceAll("자켓", "재킷") : null;
        return listReturnEligibility(tenantId, customerId, {
          reference: orderReference(question), productHint: product, view: "eligible_only",
        });
      };
      if (!action && !intent && live) {
        const inquiry = await answerInquiry({ tenantId, sessionId: authorized, customerId, question, requestId, filters: previousFilters,
          prior, previousOrders: presentedOrders(displayed.data?.order_response), lastOrder, recentTurns, report, policyAnswer });
        result = inquiry.result;
        workflowPolicy = inquiry.supplementaryPolicy;
        filters = inquiry.filters;
        checkpoint = inquiry.checkpoint;
      } else if (!action && !intent) {
        if (isReturnableOrderListQuestion(question)) result = await returnEligibility(null);
        else {
          intent = reportedMissingDelivery(question) ?? fakeActionIntent(question);
          if (!intent) filters = catalogQuery(question, previousFilters);
        }
      }
      if (action || intent) {
        if (intent?.policyQuery) workflowPolicy = await policyAnswer(intent.policyQuery, intent.policyQuery);
        const output = await runAgentWorkflow({ scope: { tenantId, sessionId: authorized, customerId }, question,
          intent, decision: action, approvalKind: prior?.approvalId === action?.approvalId ? prior?.approvalKind : undefined,
          prior, lastOrder: typeof lastOrder === "string" ? lastOrder : undefined, report });
        checkpoint = output.checkpoint;
        result = output.answer;
      }
    }

    if (!result && filters) {
      report?.("search_products");
      result = catalogAnswer(filters);
    }
    if (!result) result = await policyAnswer(question, question);
    const sources = workflowPolicy?.sources ?? result.sources;
    if (sources.length) {
      const { data: active, error: versionError } = await client.from("knowledge_documents")
        .select("id,active_version").eq("tenant_id", tenantId).eq("index_status", "ready").is("deleted_at", null)
        .in("id", sources.map((source) => source.documentId));
      if (versionError) throw new DemoError(502, "근거를 확인하지 못했어요.");
      if (sources.every((source) => active.some((doc) => doc.id === source.documentId && doc.active_version === source.version))) {
        if (workflowPolicy) result = { ...result, answer: workflowPolicy.answer + "\n\n" + result.answer, sources };
      } else if (!workflowPolicy) {
        result = explain("", []);
      }
    }
    if (workflowPolicy && !result.sources.length) {
      result = { ...result, answer: "정책 문의는 등록된 근거를 찾지 못했어요.\n\n" + result.answer };
    }
    const toolUsed = result.toolUsed;
    const { data: saved, error: saveError } = await client.from("chat_messages").insert({
      tenant_id: tenantId, session_id: authorized, role: "assistant", content: result.answer,
      reply_to_id: message.id, source_refs: result.sources, abstained: result.abstained,
      catalog_filters: filters ?? null, catalog_response: result.catalog ?? null, tool_name: toolUsed ?? null, order_response: result.orders ?? null,
      agent_response: result.action ?? null, agent_state: checkpoint ?? null, cart_response: result.cart ?? null,
    }).select("id").single();
    if (saveError) throw new DemoError(502, "답변을 저장하지 못했어요.");
    return { ...result, messageId: saved.id, ...(toolUsed && { toolUsed }) };
  } catch (error) {
    await client.from("chat_messages").delete().eq("id", message.id).eq("tenant_id", tenantId).eq("session_id", authorized);
    throw error;
  }
}
