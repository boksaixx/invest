"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/book", label: "책" },
  { href: "/journey", label: "8일의 여정" },
  { href: "/workshop", label: "워크숍" },
  { href: "/people", label: "열넷" },
];

export default function SiteNav() {
  const pathname = usePathname();
  return (
    <nav className="nav">
      <div className="wrap nav-inner">
        <Link href="/" className="nav-mark">
          <span className="dot" />
          <span className="label">문제를 다시 정의하는 법</span>
        </Link>
        <div className="nav-links">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              data-active={pathname === l.href || pathname.startsWith(`${l.href}/`)}
            >
              {l.label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
