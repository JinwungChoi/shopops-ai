import { Workspace } from "@/components/workspace";
import { LiveAdmin } from "@/components/live-admin";
import { isSupabaseEnabled } from "@/server/supabase";

export default function Home() {
  return isSupabaseEnabled() ? <LiveAdmin /> : <Workspace />;
}
