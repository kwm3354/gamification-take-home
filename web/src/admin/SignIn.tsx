import { type FormEvent, useEffect, useState } from "react";
import type { AuthState } from "./auth.ts";
import { type DemoAdmin, auth, loadDemoAdmins } from "./client.ts";

export function SignIn({ state }: { state: Extract<AuthState, { kind: "signedOut" }> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [demo, setDemo] = useState<DemoAdmin[]>([]);

  useEffect(() => {
    let live = true;
    loadDemoAdmins().then((list) => {
      if (live) setDemo(list);
    });
    return () => {
      live = false;
    };
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!state.busy) auth().signIn(email.trim(), password);
  };

  return (
    <main className="signin bo">
      <h1>Back office sign-in</h1>
      {state.notice ? (
        <p className="notice-line notice-neutral" role="status">
          {state.notice}
        </p>
      ) : null}
      <form onSubmit={submit} className="form-stack">
        <label>
          <span>Email</span>
          <input
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {state.error ? (
          <p className="notice-line notice-bad" role="alert">
            {state.error}
          </p>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={state.busy}>
          {state.busy ? "Signing in" : "Sign in"}
        </button>
      </form>
      {demo.length > 0 ? (
        <div className="demo-users">
          <p className="muted">Demo users. A button fills the form.</p>
          <ul>
            {demo.map((d) => (
              <li key={d.email}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setEmail(d.email);
                    setPassword(d.password);
                  }}
                >
                  {d.email}
                </button>
                <span className="muted">
                  {d.role}
                  {d.tenantId ? `, ${d.tenantId}` : ", all tenants"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="muted">
        <a href="#/play">Player page</a>
      </p>
    </main>
  );
}
