import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ShopOps AI — 고객지원 워크스페이스",
  description: "두 쇼핑몰의 독립적인 정책과 근거 기반 답변을 검증하는 고객지원 데모",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
