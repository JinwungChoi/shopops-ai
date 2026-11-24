export const shops = {
  "demo-style-shop": { name: "Style Shop", initial: "S" },
  "demo-gadget-shop": { name: "Gadget Shop", initial: "G" },
} as const;

export type ShopId = keyof typeof shops;
export const showcaseShop = "demo-style-shop" satisfies ShopId;
export type Category = "returns" | "shipping" | "exchange" | "support";
export type Document = {
  id: string;
  title: string;
  content: string;
  category: Category;
  version: number;
  status: "ready" | "pending";
};

export type Source = { documentId: string; title: string; version: number; excerpt: string };
export type ProductCard = {
  id: string;
  name: string;
  color: string;
  price: number;
  image: string | null;
  releasedAt: string;
  options: { size: string; available: boolean }[];
};
export type CatalogResult = { products: ProductCard[] };
export type AgentTool = "search_policies" | "search_products" | "get_order_status" | "list_orders" | "track_shipment"
  | "check_return_eligibility" | "submit_return_request" | "create_support_ticket"
  | "get_product" | "view_cart" | "update_cart" | "prepare_checkout" | "place_order"
  | "list_addresses" | "prepare_order_change" | "change_order";
export type CartLine = { productId: string; name: string; size: string; quantity: number; unitPrice: number; lineTotal: number };
export type CartResult = { lines: CartLine[]; subtotal: number; shippingFee: number; total: number };
export type ProductDetail = { id: string; name: string; price: number; material: string; fit: string; care: string;
  image: string | null; options: { size: string; stock: number }[] };
export type OrderChangeKind = "cancel" | "address" | "exchange";
export type OrderChangeDetail = { addressId?: string; label?: string; summary?: string; size?: string; fromSize?: string | null };
export type SavedAddress = { id: string; label: string; summary: string; isDefault: boolean };
export type OrderSummary = { reference: string; name: string; orderedAt: string; status: string; quantity: number; total: number | null };
export type ReturnEligibility = "eligible" | "not_delivered" | "too_late" | "already_submitted" | "review" | "canceled";
export type OrderResult =
  | { kind: "history"; items: OrderSummary[] }
  | { kind: "return_eligibility"; items: (OrderSummary & { eligibility: ReturnEligibility })[] }
  | { kind: "shipment"; order: OrderSummary; carrier: string | null; trackingNumber: string | null;
      events: { occurredAt: string; location: string; description: string }[] };
export type ActionDecision = { approvalId: string; decision: "confirm" | "cancel"; itemConditionConfirmed: boolean };
export type AgentAction =
  | { kind: "select_order"; items: OrderSummary[] }
  | { kind: "return_reason" }
  | { kind: "approval"; id: string; action: "return" | "support"; reason: string; expiresAt: string;
      order?: OrderSummary; quantity: number | null; fee: number | null }
  | { kind: "checkout"; id: string; expiresAt: string; cart: CartResult }
  | { kind: "change"; id: string; change: OrderChangeKind; expiresAt: string; order: OrderSummary; detail: OrderChangeDetail }
  | { kind: "addresses"; items: SavedAddress[] }
  | { kind: "receipt"; action: "return" | "support" | "checkout" | OrderChangeKind; id: string; approvalId: string; orders?: string[]; total?: number }
  | { kind: "closed"; approvalId: string };
export type Answer = { answer: string; sources: Source[]; abstained: boolean; catalog?: CatalogResult; toolUsed?: AgentTool; orders?: OrderResult; action?: AgentAction;
  cart?: CartResult; product?: ProductDetail };

export const categories: Record<Category, string> = {
  returns: "반품", shipping: "배송", exchange: "교환", support: "고객지원",
};

export const suggestions = [
  { title: "신상 재킷", question: "신상 재킷 보여줘", category: "new" },
  { title: "반품 기간", question: "받은 지 열흘 됐는데 반품할 수 있나요?", category: "returns" },
  { title: "배송 안내", question: "배송은 보통 얼마나 걸리나요?", category: "shipping" },
  { title: "교환 절차", question: "상품을 교환하려면 어떻게 하나요?", category: "exchange" },
] as const;

