import { useEffect, useRef, useState } from "react";
import {
  deleteTable,
  getSlice,
  listTables,
  renameTable,
  type TableSlice,
  type TableSummary,
  uploadTable,
} from "../api";
import DataTable from "../components/DataTable";
import logo from "../images/logo.png";
import uploadLogo from "../images/upload.png";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("Uploaded Table");
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [preview, setPreview] = useState<TableSlice | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [activeTableId, setActiveTableId] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showScrollHint, setShowScrollHint] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const tablesScrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function refresh() {
    const nextTables = await listTables();
    setTables(nextTables);
  }

  useEffect(() => {
    refresh().catch((error: unknown) => {
      setErr(getErrorMessage(error));
    });
  }, []);

  useEffect(() => {
    const element = tablesScrollRef.current;
    if (!element) {
      return;
    }

    const updateHint = () => {
      const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 4;
      const canScroll = element.scrollHeight > element.clientHeight + 2;
      setShowScrollHint(canScroll && !atBottom);
    };

    updateHint();
    element.addEventListener("scroll", updateHint);
    window.addEventListener("resize", updateHint);

    return () => {
      element.removeEventListener("scroll", updateHint);
      window.removeEventListener("resize", updateHint);
    };
  }, [tables.length]);

  async function loadPreview(datasetId: number) {
    setActiveTableId(datasetId);
    setPreviewBusy(true);
    setPreviewErr(null);

    try {
      const slice = await getSlice(datasetId, 0, 50);
      setPreview(slice);
    } catch (error: unknown) {
      setPreviewErr(getErrorMessage(error));
      setPreview(null);
    } finally {
      setPreviewBusy(false);
    }
  }

  async function onUpload() {
    if (!file) {
      return;
    }

    setBusy(true);
    setErr(null);
    setStatus("Uploading...");

    try {
      const result = await uploadTable(file, name);
      setStatus(null);
      await refresh();
      await loadPreview(result.dataset_id);
      setToast("File uploaded successfully");
      window.setTimeout(() => setToast(null), 2400);
      setFile(null);
      setName("Uploaded Table");
    } catch (error: unknown) {
      setErr(getErrorMessage(error));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(datasetId: number) {
    try {
      await deleteTable(datasetId);
      if (activeTableId === datasetId) {
        setActiveTableId(null);
        setPreview(null);
      }
      await refresh();
    } catch (error: unknown) {
      setErr(getErrorMessage(error));
    }
  }

  async function onRename(datasetId: number) {
    const nextName = editingName.trim();
    if (!nextName) {
      setErr("Name cannot be empty.");
      return;
    }

    try {
      await renameTable(datasetId, nextName);
      setEditingId(null);
      setEditingName("");
      await refresh();
    } catch (error: unknown) {
      setErr(getErrorMessage(error));
    }
  }

  function onSelectFile(nextFile: File | null) {
    setFile(nextFile);
    if (nextFile) {
      const withoutExt = nextFile.name.replace(/\.[^.]+$/, "");
      setName(withoutExt || nextFile.name);
    }
  }

  return (
    <div className="page page-stack">
      {toast && <div className="toast success">{toast}</div>}

      <div className="hero">
        <div className="hero-title-row">
          <img src={logo} alt="TabulaRAG" className="hero-logo" />
          <div className="hero-title">TabulaRAG</div>
        </div>
        <div className="hero-subtitle">Upload, Preview, and Query Table with Citation.</div>
      </div>

      <div className="panel upload-panel">
        {!file ? (
          <label className="upload-drop">
            <input
              type="file"
              accept=".csv,.tsv"
              onChange={(event) => onSelectFile(event.target.files?.[0] || null)}
            />
            <div className="upload-icon" aria-hidden="true">
              <img src={uploadLogo} alt="" />
            </div>
            <div className="upload-title">Upload CSV/TSV file</div>
            <div className="upload-subtitle">Click to select a file</div>
          </label>
        ) : (
          <>
            <h2>Upload CSV/TSV</h2>
            <div className="row">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.tsv"
                onChange={(event) => onSelectFile(event.target.files?.[0] || null)}
                className="file-input-hidden"
              />
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                style={{ minWidth: 240 }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                type="button"
                className="glass"
              >
                Change file
              </button>
              <button onClick={onUpload} disabled={!file || busy} className="primary" type="button">
                {busy ? "Uploading..." : "Upload"}
              </button>
            </div>
            <div className="small">Selected: {file.name}</div>
          </>
        )}

        {err && <p className="error">{err}</p>}
        {status && !err && <p className="small status-info">{status}</p>}
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ marginBottom: 0 }}>Uploaded tables</h3>
          <span className="small">Tap a table to preview</span>
        </div>

        <div className="tables-scroll" ref={tablesScrollRef}>
          <ul>
            {tables.map((table) => (
              <li key={table.dataset_id}>
                <div className="list-row">
                  <div className="list-item">
                    {editingId === table.dataset_id ? (
                      <input
                        value={editingName}
                        onChange={(event) => setEditingName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            void onRename(table.dataset_id);
                          }
                        }}
                        className="rename-input"
                      />
                    ) : (
                      <button
                        type="button"
                        className="list-button"
                        onClick={() => {
                          void loadPreview(table.dataset_id);
                        }}
                      >
                        <span className="mono">{table.name}</span>{" "}
                        <span className="small">
                          ({table.row_count} rows, {table.column_count} cols)
                        </span>
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    className={`icon-button ${editingId === table.dataset_id ? "success" : "edit"}`}
                    onClick={() => {
                      if (editingId === table.dataset_id) {
                        void onRename(table.dataset_id);
                      } else {
                        setEditingId(table.dataset_id);
                        setEditingName(table.name);
                      }
                    }}
                    aria-label={editingId === table.dataset_id ? "Save name" : `Rename ${table.name}`}
                    title={editingId === table.dataset_id ? "Save" : "Rename"}
                  >
                    {editingId === table.dataset_id ? (
                      <svg viewBox="0 0 24 24" role="presentation">
                        <path d="M9.2 16.6 4.8 12.2a1 1 0 1 1 1.4-1.4l3 3 8-8a1 1 0 0 1 1.4 1.4l-8.8 8.8a1 1 0 0 1-1.4 0z" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" role="presentation">
                        <path d="M15.2 4.2a2 2 0 0 1 2.8 0l1.8 1.8a2 2 0 0 1 0 2.8l-9.8 9.8a1 1 0 0 1-.5.27l-4.5 1a1 1 0 0 1-1.2-1.2l1-4.5a1 1 0 0 1 .27-.5l9.8-9.8zM6.7 15.3l-.6 2.5 2.5-.6 8.6-8.6-1.9-1.9-8.6 8.6z" />
                      </svg>
                    )}
                  </button>

                  <button
                    type="button"
                    className="icon-button danger"
                    onClick={() => {
                      void onDelete(table.dataset_id);
                    }}
                    aria-label={`Delete ${table.name}`}
                    title="Delete table"
                  >
                    <svg viewBox="0 0 24 24" role="presentation">
                      <path d="M9 3a1 1 0 0 0-1 1v1H5a1 1 0 0 0 0 2h1v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7h1a1 1 0 1 0 0-2h-3V4a1 1 0 0 0-1-1H9zm1 2h4v0H10zm-1 4a1 1 0 0 1 2 0v8a1 1 0 1 1-2 0V9zm6-1a1 1 0 0 1 1 1v8a1 1 0 1 1-2 0V9a1 1 0 0 1 1-1z" />
                    </svg>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {showScrollHint && <div className="scroll-indicator" aria-hidden="true">▼</div>}

        <div className="small" style={{ marginTop: 8 }}>
          Tip: Once Open WebUI calls <span className="mono">/query</span>, it returns a
          <span className="mono"> highlight_url</span> you can open here.
        </div>
      </div>

      <div className="panel upload-preview">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ marginBottom: 0 }}>Table preview</h3>
          {activeTableId !== null && (
            <span className="small mono">
              {tables.find((table) => table.dataset_id === activeTableId)?.name || "Table"}
            </span>
          )}
        </div>

        {previewBusy && <p className="small">Loading preview...</p>}
        {previewErr && <p className="error">{previewErr}</p>}

        {preview && (
          <div className="table-area">
            <DataTable columns={preview.columns} rows={preview.rows} />
          </div>
        )}

        {!previewBusy && !preview && !previewErr && (
          <p className="small">Select a table above to preview the first 50 rows.</p>
        )}
      </div>
    </div>
  );
}
