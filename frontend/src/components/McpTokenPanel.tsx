import { useCallback, useEffect, useState } from "react";
import {
  createOrRotateMcpToken,
  getMcpTokenStatus,
  revokeMcpToken,
  type McpTokenStatus,
} from "../api";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

export default function McpTokenPanel() {
  const [status, setStatus] = useState<McpTokenStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getMcpTokenStatus()
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load MCP token status"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const mcpUrl = `${API_BASE.replace(/\/$/, "")}/mcp`;
  const cursorSnippet = `{
  "mcpServers": {
    "tabularag": {
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_HERE"
      }
    }
  }
}`;

  async function onCreateOrRotate() {
    setBusy(true);
    setError(null);
    try {
      const data = await createOrRotateMcpToken();
      setRevealedToken(data.token);
      setStatus({
        configured: true,
        created_at: data.created_at,
        hint: "tgr_mcp_… (full value shown only when created)",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create token");
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke() {
    setBusy(true);
    setError(null);
    try {
      await revokeMcpToken();
      setRevealedToken(null);
      setStatus({ configured: false, created_at: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke");
    } finally {
      setBusy(false);
    }
  }

  function copyToken() {
    if (revealedToken) {
      void navigator.clipboard.writeText(revealedToken);
    }
  }

  return (
    <section
      className="mcp-token-panel"
      style={{
        maxWidth: 640,
        margin: "0 auto 1.5rem",
        padding: "1rem 1.25rem",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface)",
      }}
    >
      <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>MCP (Cursor &amp; tools)</h2>
      <p className="small" style={{ margin: "0 0 0.75rem", opacity: 0.85 }}>
        Create a personal token for this workspace. It stops working if you leave the enterprise. The MCP endpoint
        requires this token (or the server API key). Paste the token into{" "}
        <code style={{ fontSize: "0.8em" }}>Authorization: Bearer …</code> in your MCP client config.
      </p>
      {loading && <p style={{ opacity: 0.6 }}>Loading…</p>}
      {error && (
        <p className="login-error" role="alert" style={{ marginBottom: "0.5rem" }}>
          {error}
        </p>
      )}
      {!loading && status && (
        <>
          <p style={{ margin: "0 0 0.5rem", fontSize: "0.875rem" }}>
            Status:{" "}
            <strong>{status.configured ? "Token on file" : "No token — create one to connect"}</strong>
            {status.created_at && (
              <span style={{ opacity: 0.7 }}>
                {" "}
                · created {new Date(status.created_at).toLocaleString()}
              </span>
            )}
          </p>
          {revealedToken && (
            <div style={{ marginBottom: "0.75rem" }}>
              <label className="small" style={{ display: "block", marginBottom: "0.25rem" }}>
                Copy now — this is the only time the full token is shown:
              </label>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                <input
                  className="input"
                  readOnly
                  value={revealedToken}
                  style={{ flex: "1 1 200px", fontFamily: "monospace", fontSize: "0.75rem" }}
                />
                <button type="button" className="surface-btn" onClick={copyToken}>
                  Copy token
                </button>
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
            <button type="button" className="login-btn" disabled={busy} onClick={() => void onCreateOrRotate()}>
              {status.configured ? "Regenerate token" : "Create token"}
            </button>
            {status.configured && (
              <button type="button" className="surface-btn" disabled={busy} onClick={() => void onRevoke()}>
                Revoke token
              </button>
            )}
          </div>
          <details style={{ fontSize: "0.8125rem" }}>
            <summary style={{ cursor: "pointer", marginBottom: "0.35rem" }}>Example Cursor MCP config</summary>
            <pre
              style={{
                margin: 0,
                padding: "0.75rem",
                overflow: "auto",
                borderRadius: 6,
                background: "var(--bg-muted, #f4f4f5)",
                fontSize: "0.72rem",
              }}
            >
              {cursorSnippet}
            </pre>
            <p style={{ margin: "0.5rem 0 0", opacity: 0.8 }}>
              Replace <code>YOUR_TOKEN_HERE</code> with your token. MCP URL:{" "}
              <code>{mcpUrl}</code>
            </p>
          </details>
        </>
      )}
    </section>
  );
}
