import Head from "next/head";
import { FormEvent, useEffect, useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => {
        if (payload?.ok) {
          window.location.href = "/";
        }
      })
      .catch(() => {});
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(false);
    setMessage("Signing in...");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(true);
        setMessage(payload.error || "Sign in failed.");
        return;
      }
      window.location.href = "/";
    } catch {
      setError(true);
      setMessage("Could not reach admin server.");
    }
  }

  return (
    <>
      <Head>
        <title>Admin Panel Login</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="stylesheet" href="/common.css" />
      </Head>
      <main className="login-wrap">
        <section className="login-card">
          <h1 className="login-title">Admin Sign In</h1>
          <p className="note login-note">
            Sign in with your Supabase account. Access is granted only to users in <code>admin_users</code>.
          </p>
          <form id="login-form" className="login-form" onSubmit={onSubmit}>
            <input
              id="login-email"
              type="email"
              placeholder="Email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <input
              id="login-password"
              type="password"
              placeholder="Password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <div className="row login-actions">
              <button type="submit">Sign In</button>
              <span id="login-message" className={error ? "error" : "mini"}>{message}</span>
            </div>
          </form>
        </section>
      </main>
    </>
  );
}
