"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** V4 页面顶部导航（鲸天风格） */
export default function V4Nav() {
  const pathname = usePathname();
  const links = [
    { href: "/", label: "导入工作台（V2）" },
    { href: "/tasks", label: "导入任务" },
    { href: "/monitor", label: "监控看板" },
    { href: "/traces", label: "Trace 检索" }
  ];
  return (
    <nav className="v4-nav" aria-label="V4 导航">
      <strong>万能导入 V4</strong>
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={pathname === link.href || (link.href !== "/" && pathname.startsWith(link.href)) ? "active" : ""}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
