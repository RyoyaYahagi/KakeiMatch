"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/", label: "ホーム" },
  { href: "/transactions", label: "支出" },
  { href: "/reconciliation", label: "照合" },
  { href: "/settings", label: "設定" },
];

export default function MainNavigation() {
  const pathname = usePathname();
  return (
    <nav className="bottom-nav" aria-label="メインメニュー">
      {items.map((item) => {
        const current = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return <Link key={item.href} href={item.href} aria-current={current ? "page" : undefined}>{item.label}</Link>;
      })}
    </nav>
  );
}
