import { notFound } from "next/navigation";
import { PublicWidget } from "@/components/workspace";
import { shops, showcaseShop } from "@/lib/demo";
import { styleCatalogWidget } from "@/server/catalog";
import { serverClient, isSupabaseEnabled } from "@/server/supabase";

export const dynamic = "force-dynamic";

export default async function PublicChat({ params }: { params: Promise<{ publicWidgetKey: string }> }) {
  const { publicWidgetKey } = await params;
  if (!isSupabaseEnabled()) {
    if (publicWidgetKey !== showcaseShop) notFound();
    return <PublicWidget widgetKey={showcaseShop} name={shops[showcaseShop].name} catalogEnabled />;
  }

  if (!/^[a-f0-9]{32}$/.test(publicWidgetKey)) notFound();
  const { data, error } = await serverClient().from("tenants").select("name")
    .eq("public_widget_key", publicWidgetKey).eq("is_active", true).maybeSingle();
  if (error) throw new Error("채팅을 열 수 없어요.");
  if (!data) notFound();
  return <PublicWidget widgetKey={publicWidgetKey} name={String(data.name)} catalogEnabled={publicWidgetKey === styleCatalogWidget} customerEnabled={publicWidgetKey === styleCatalogWidget} />;
}
