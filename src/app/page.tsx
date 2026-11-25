import { Workspace } from "@/components/workspace";
import { LiveAdmin } from "@/components/live-admin";
import { redirect } from "next/navigation";
import { styleCatalogWidget } from "@/server/catalog";
import { isPublicDemo, isSupabaseEnabled } from "@/server/supabase";

export default function Home() {
  // 공개 데모는 관리자 화면 대신 Style Shop 고객 채팅으로 보낸다.
  if (isPublicDemo()) redirect("/chat/" + styleCatalogWidget);
  return isSupabaseEnabled() ? <LiveAdmin /> : <Workspace />;
}
