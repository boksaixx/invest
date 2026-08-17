import type { Metadata, Viewport } from "next";
import SiteNav from "@/components/SiteNav";
import { book } from "@/content/front";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: `${book.title} — ${book.series}`,
    template: `%s · ${book.title}`,
  },
  description: book.dek,
  openGraph: {
    title: book.title,
    description: book.dek,
    type: "book",
  },
};

export const viewport: Viewport = {
  themeColor: "#070d17",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <SiteNav />
        <main>{children}</main>
        <footer className="foot">
          <div className="wrap row">
            <div>
              <div style={{ color: "var(--ink-soft)", fontWeight: 600 }}>
                {book.title}
              </div>
              <div style={{ marginTop: ".3rem" }}>
                {book.author} · {book.edition}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div>{book.period}</div>
              <div style={{ marginTop: ".3rem" }}>{book.places}</div>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
