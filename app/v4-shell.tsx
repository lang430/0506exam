"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Boxes, FileUp, Home, Search } from "lucide-react";

/**
 * V4 全站布局壳：参考鲸天系统设计语言（左侧固定深色菜单 + 顶部信息条 + 圆角卡片内容区），
 * 主色 #0fc6c2。菜单点击直接跳转对应页面。
 */

const MENU = [
  { href: "/", label: "导入工作台", icon: Home, exact: true },
  { href: "/tasks", label: "导入任务", icon: FileUp, exact: false },
  { href: "/monitor", label: "监控看板", icon: Activity, exact: false },
  { href: "/traces", label: "Trace 检索", icon: Search, exact: false }
];

interface V4ShellProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

export default function V4Shell({ title, subtitle, children }: V4ShellProps) {
  const pathname = usePathname();
  const isActive = (item: (typeof MENU)[number]): boolean =>
    item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <div className="v4-app">
      <aside className="v4-sidebar" aria-label="主导航">
        <div className="v4-brand">
          <span className="v4-logo"><Boxes size={20} /></span>
          <div>
            <strong>万能导入</strong>
            <span>V4 · 异步事件驱动</span>
          </div>
        </div>
        <nav>
          {MENU.map((item) => (
            <Link key={item.href} href={item.href} className={isActive(item) ? "active" : ""} aria-current={isActive(item) ? "page" : undefined}>
              <item.icon size={17} />
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>
        <div className="v4-side-foot">
          <span className="dot" />
          <span>生产环境 · Vercel</span>
        </div>
      </aside>

      <div className="v4-main">
        <header className="v4-topbar">
          <div>
            <h1>{title}</h1>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <div className="v4-top-meta">
            <span className="code-pill">主色 #0fc6c2</span>
            <Link href="/tasks" className="v4-top-link">新建导入</Link>
          </div>
        </header>
        <div className="v4-content">{children}</div>
      </div>
    </div>
  );
}
