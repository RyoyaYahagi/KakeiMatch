import type { ReactNode } from "react";
import Link from "next/link";
import { requireUser } from "@/lib/current-user";
import MainNavigation from "../components/main-navigation";

export default async function ProtectedLayout({ children }: Readonly<{ children: ReactNode }>) {
  const user = await requireUser();

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link className="wordmark" href="/">KakeiMatch</Link>
        <div className="app-header-account">
          <span className="account-name">{user.name || user.email}</span>
        </div>
      </header>
      <main className="app-main">{children}</main>
      <MainNavigation />
    </div>
  );
}
