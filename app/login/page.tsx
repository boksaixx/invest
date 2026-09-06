"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const params = useSearchParams();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // 같은 사이트 안의 경로만 허용 — "?next=//evil.com" 같은 외부 이동(오픈 리다이렉트)을 막는다
        const raw = params.get("next") || "/";
        const next = raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : "/";
        router.replace(next);
        router.refresh();
      } else {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "로그인에 실패했습니다.");
      }
    } catch {
      setError("네트워크 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container" style={{ paddingTop: 100 }}>
      <div className="card">
        <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>🔒 내 주식 비서</div>
        <div className="hint" style={{ marginBottom: 20 }}>비밀번호를 입력하세요</div>
        <form onSubmit={submit}>
          <input
            type="password"
            autoFocus
            inputMode="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="비밀번호"
            className="login-input"
          />
          {error && <div style={{ color: "var(--red)", fontSize: 13, fontWeight: 700, margin: "10px 0" }}>{error}</div>}
          <button className="btn btn-primary" type="submit" disabled={loading || !password} style={{ marginTop: 12 }}>
            {loading ? "확인 중…" : "입장하기"}
          </button>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
