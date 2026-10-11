import { useState } from "react";
import { ErrorNotice, Field } from "../components/ui";
import { useSession } from "../session";

/** Sign-in with an admin token. The token is exchanged for a session cookie and then forgotten. */
export function Login() {
  const session = useSession();
  const [token, setToken] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await session.signIn(token);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin-wrap">
      <main className="signin-card">
        <div className="signin-header">
          <div className="row gap-12">
            <div className="brand-mark" aria-hidden="true">{session.brand.brand_name.charAt(0).toUpperCase()}</div>
            <h1>{session.brand.brand_name}</h1>
          </div>
          <p style={{ marginTop: 8 }}>Sign in with an admin token to manage the gateway.</p>
        </div>
        <form className="signin-body" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <ErrorNotice error={error} />
          <Field label="Admin token" hint="It starts with apg_at_. An administrator creates tokens under Settings, or with apgctl tokens create.">
            {(id, describedBy) => (
              <input id={id} className="input mono" type="password" autoComplete="off" autoFocus required aria-describedby={describedBy} value={token} onChange={(e) => setToken(e.target.value)} />
            )}
          </Field>
          <button type="submit" className="btn btn-primary" disabled={busy || token.trim() === ""}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
        <div className="signin-footer">The token is exchanged for a session and is not kept in this browser.</div>
      </main>
    </div>
  );
}

/** Shown inside a frame until the host page hands over a token (spec UI-7). */
export function WaitingForHost() {
  return (
    <div className="state" role="status">
      <h3>Waiting for the host page</h3>
      <div>This view is embedded. The page around it signs you in.</div>
    </div>
  );
}
