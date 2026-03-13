import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { getHighlight, type HighlightResponse } from "../api";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function parseRequestedHighlightIds(primaryId: string, search: string): string[] {
  const params = new URLSearchParams(search);
  const rawTargets = params.get("targets") || "";
  const extraIds = rawTargets
    .split(/[,\s|]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of [primaryId, ...extraIds]) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    ordered.push(id);
  }
  return ordered;
}

function buildTableViewUrl(highlight: HighlightResponse, search: string): string {
  const params = new URLSearchParams(search);
  const nextParams = new URLSearchParams();
  nextParams.set("highlight_row", String(highlight.row_index));
  if (highlight.column) {
    nextParams.set("highlight_col", highlight.column);
  }

  const returnTo = params.get("return_to");
  if (returnTo) {
    nextParams.set("return_to", returnTo);
  }

  const queryText = params.get("q");
  if (queryText) {
    nextParams.set("q", queryText);
  }

  return `/tables/${highlight.dataset_id}?${nextParams.toString()}`;
}

export default function HighlightView() {
  const { highlightId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [err, setErr] = useState<string | null>(null);

  const requestedIds = useMemo(
    () => (highlightId ? parseRequestedHighlightIds(highlightId, location.search) : []),
    [highlightId, location.search],
  );

  useEffect(() => {
    if (!highlightId || requestedIds.length === 0) {
      return;
    }

    let cancelled = false;

    (async () => {
      setErr(null);
      const highlights = await Promise.all(
        requestedIds.map(async (id) => {
          try {
            return await getHighlight(id);
          } catch {
            return null;
          }
        }),
      );
      const firstValidHighlight = highlights.find(
        (value): value is HighlightResponse => value !== null,
      );
      if (!firstValidHighlight) {
        throw new Error("Highlight not found.");
      }
      if (cancelled) {
        return;
      }
      navigate(buildTableViewUrl(firstValidHighlight, location.search), { replace: true });
    })().catch((error: unknown) => {
      if (!cancelled) {
        setErr(getErrorMessage(error));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [highlightId, location.search, navigate, requestedIds]);

  if (!highlightId) {
    return null;
  }

  return (
    <div className="page-stack">
      {err ? (
        <>
          <p className="error">{err}</p>
          <Link className="return-link" to="/">
            Back to Upload
          </Link>
        </>
      ) : (
        <p className="small">Opening table highlight...</p>
      )}
    </div>
  );
}
