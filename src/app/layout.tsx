import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "KakeiMatch",
  description: "家計の記録と明細確認を支援します。",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}
