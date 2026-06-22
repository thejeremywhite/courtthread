"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/", label: "Dashboard", icon: "🏠" },
  { href: "/import", label: "Import", icon: "📥" },
  { href: "/conversations", label: "Conversations", icon: "💬" },
  { href: "/search", label: "Search", icon: "🔍" },
  { href: "/bookmarks", label: "Bookmarks", icon: "⭐" },
  { href: "/export", label: "Export", icon: "📤" },
  { href: "/settings", label: "Settings", icon: "⚙️" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="fixed left-0 top-0 h-full w-64 border-r border-[var(--border)] bg-[var(--card)] p-4 no-print">
      <div className="mb-8">
        <h1 className="text-xl font-bold">CourtThread</h1>
        <p className="text-xs text-[var(--muted-foreground)]">
          Evidence Viewer
        </p>
      </div>

      <ul className="space-y-1">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
                  isActive
                    ? "bg-[var(--primary)] text-white"
                    : "text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                }`}
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
