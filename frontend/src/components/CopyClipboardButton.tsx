import { useEffect, useState } from "react";

type CopyClipboardButtonProps = {
  onClick: () => void;
  disabled?: boolean;
  /** Defaults to "Copy to clipboard". */
  ariaLabel?: string;
  title?: string;
  className?: string;
};

/** Icon-only control; uses global `.icon-button` styles. */
export default function CopyClipboardButton({
  onClick,
  disabled,
  ariaLabel = "Copy to clipboard",
  title,
  className = "",
}: CopyClipboardButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  return (
    <span className="copy-clipboard-wrap">
      <button
        type="button"
        className={`icon-button${className ? ` ${className}` : ""}`}
        onClick={() => {
          onClick();
          setCopied(true);
        }}
        disabled={disabled}
        aria-label={ariaLabel}
        title={title ?? ariaLabel}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
        </svg>
      </button>
      <span className="copy-clipboard-status" aria-live="polite" aria-atomic="true">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </span>
  );
}
