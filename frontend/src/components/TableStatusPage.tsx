import { Link } from "react-router-dom";

export function TableStatusCard(props: {
  code: string;
  title: string;
  description: string;
}) {
  return (
    <div className="table-status-card-outer">
      <div className="card table-status-card" role="alert">
        <p className="table-status-code">{props.code}</p>
        <p className="table-status-title">{props.title}</p>
        <p className="table-status-desc">{props.description}</p>
      </div>
    </div>
  );
}

type TableStatusPageProps = {
  code: string;
  title: string;
  description: string;
  /** When false, omits the top "Back to Home" row (e.g. home page offline state). */
  showBackLink?: boolean;
};

export default function TableStatusPage(props: TableStatusPageProps) {
  const showBack = props.showBackLink !== false;
  return (
    <div className="page-stack full-table-page table-status-page-root">
      {showBack ? (
        <div className="table-view-back-row">
          <Link className="table-view-context-btn" to="/" aria-label="Back to home" title="Back to home">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M20 11H7.83l4.59-4.59a1 1 0 1 0-1.42-1.41l-6.3 6.29a1 1 0 0 0 0 1.42l6.3 6.29a1 1 0 1 0 1.42-1.41L7.83 13H20a1 1 0 1 0 0-2Z"
                fill="currentColor"
              />
            </svg>
            Back to Home
          </Link>
        </div>
      ) : null}
      <div className="table-status-layout">
        <TableStatusCard code={props.code} title={props.title} description={props.description} />
      </div>
    </div>
  );
}
