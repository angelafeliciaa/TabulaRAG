import { useCallback, useEffect, useState } from "react";
import CopyClipboardButton from "./CopyClipboardButton";
import {
  API_BASE,
  createOrRotateMcpToken,
  getMcpTokenStatus,
  revokeMcpToken,
  type McpTokenStatus,
} from "../api";

type McpTokenPanelProps = {
  /** Omit outer box when nested inside a `.panel` (e.g. Settings). */
  embedded?: boolean;
};

export default function McpTokenPanel({ embedded = false }: McpTokenPanelProps) {
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

  const base = API_BASE.replace(/\/$/, "");
  const mcpUrlHttp = `${base}/mcp`;
  const mcpUrlSse = `${base}/sse`;
  const cursorSnippet = `{
  "mcpServers": {
    "tabularag": {
      "url": "${mcpUrlHttp}",
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
        hint: "tgr_mcp_… (full value shown only when generated)",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate token");
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
    <section className={`mcp-token-panel${embedded ? " mcp-token-panel--embedded" : ""}`}>
      {!embedded ? (
        <h2 className="mcp-token-panel-title">MCP (Cursor &amp; tools)</h2>
      ) : null}
      <p className="mcp-token-panel-intro">
        Generate a personal token for this workspace. It stops working if you leave the workspace. The MCP endpoint
        requires this token—paste it into your MCP client as{" "}
        <code className="mcp-token-panel-intro-code">Authorization: Bearer …</code>.
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
            <strong>{status.configured ? "Token on file" : "No token — generate one to connect"}</strong>
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
                <CopyClipboardButton ariaLabel="Copy MCP token to clipboard" onClick={copyToken} />
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
            <button type="button" className="login-btn" disabled={busy} onClick={() => void onCreateOrRotate()}>
              {status.configured ? "Regenerate token" : "Generate token"}
            </button>
            {status.configured && (
              <button type="button" className="surface-btn" disabled={busy} onClick={() => void onRevoke()}>
                Revoke token
              </button>
            )}
          </div>
          <details style={{ fontSize: "0.8125rem" }}>
            <summary style={{ cursor: "pointer", marginBottom: "0.35rem" }}>Example Cursor MCP config</summary>
            <pre className="mcp-token-panel-config-snippet">
              {cursorSnippet}
            </pre>
            <p style={{ margin: "0.5rem 0 0", opacity: 0.8 }}>
              Replace <code>YOUR_TOKEN_HERE</code> with your token. Prefer streamable HTTP:{" "}
              <code>{mcpUrlHttp}</code>. If Cursor logs SSE / 404 errors, try the same headers with{" "}
              <code>{mcpUrlSse}</code> (or <code>{base}/mcp/sse</code>).
            </p>
          </details>
          <details style={{ fontSize: "0.8125rem", marginTop: "0.65rem" }}>
            <summary style={{ cursor: "pointer", marginBottom: "0.35rem" }}>
              Tools not listed in chat? (Cursor)
            </summary>
            <ul
              style={{
                margin: "0.25rem 0 0",
                paddingLeft: "1.15rem",
                lineHeight: 1.5,
                opacity: 0.88,
              }}
            >
              <li>
                MCP tools are attached <strong>per chat session</strong>. After fixing config, open a{" "}
                <strong>new chat</strong> so the assistant sees TabulaRAG tools (e.g. listing tables).
              </li>
              <li>
                In Cursor, open <strong>Settings → MCP</strong> and confirm <strong>tabularag</strong> is enabled and
                shows as connected (no error). URL and Bearer token must match this workspace.
              </li>
              <li>
                If you just added or changed the token: try <strong>Developer: Reload Window</strong> from the command
                palette, or turn the TabulaRAG server <strong>off</strong> then <strong>on</strong> in MCP settings.
              </li>
              <li>
                Errors like <strong>SSE</strong> + <strong>404</strong> + &quot;Invalid OAuth error response&quot;
                usually mean the client probed an SSE path we did not expose. The server now serves SSE at{" "}
                <code>/sse</code> and <code>/mcp/sse</code> as well as HTTP at <code>/mcp</code>; switch the config{" "}
                <code>url</code> if needed (same <code>Authorization</code> header).
              </li>
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
