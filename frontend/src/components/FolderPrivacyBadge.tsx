import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FolderPrivacy } from "../api";
import iconPublic from "../images/icon_lock_public.svg";
import iconProtected from "../images/icon_lock_protected.svg";
import iconPrivate from "../images/icon_lock_private.svg";

const LABELS: Record<FolderPrivacy, string> = {
  public: "Public",
  protected: "Protected",
  private: "Private",
};

const ICONS: Record<FolderPrivacy, string> = {
  public: iconPublic,
  protected: iconProtected,
  private: iconPrivate,
};

/** CSS class suffix applied to the badge/select wrapper. */
const COLOR_CLASS: Record<FolderPrivacy, string> = {
  public: "success",
  protected: "warning",
  private: "muted",
};

type Props = {
  privacy: FolderPrivacy;
  /** When provided the badge becomes an admin-only <select> dropdown. */
  onChange?: (next: FolderPrivacy) => void;
  disabled?: boolean;
  className?: string;
};

/**
 * Small coloured badge that displays a folder's privacy level.
 * Pass `onChange` to turn it into an editable dropdown (admin use).
 */
export default function FolderPrivacyBadge({
  privacy,
  onChange,
  disabled,
  className = "",
}: Props) {
  const colorClass = `privacy-badge--${COLOR_CLASS[privacy]}`;
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!onChange || !open) return;

    function onPointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onChange, open]);

  if (onChange) {
    return (
      <span
        ref={rootRef}
        className={`privacy-badge-wrap${className ? ` ${className}` : ""}`}
      >
        <button
          ref={buttonRef}
          type="button"
          className={`privacy-badge privacy-badge--button ${colorClass}`}
          aria-label="Folder privacy"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          disabled={disabled}
          title={LABELS[privacy]}
          onClick={() => {
            setOpen((v) => {
              const next = !v;
              if (next) {
                const rect = buttonRef.current?.getBoundingClientRect();
                if (rect) {
                  setMenuPos({
                    top: rect.bottom + 6,
                    right: Math.max(8, window.innerWidth - rect.right),
                  });
                }
              }
              return next;
            });
          }}
        >
          <img
            className="privacy-badge__icon"
            src={ICONS[privacy]}
            alt=""
            aria-hidden="true"
          />
        </button>

        {open && (
          menuPos &&
          createPortal(
            <div
              ref={menuRef}
              id={menuId}
              className="privacy-badge-menu"
              role="menu"
              style={{
                position: "fixed",
                top: menuPos.top,
                right: menuPos.right,
              }}
            >
              {(["public", "protected", "private"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={privacy === key}
                  className={`privacy-badge-menu__item${privacy === key ? " is-active" : ""}`}
                  onClick={() => {
                    setOpen(false);
                    setMenuPos(null);
                    onChange(key);
                  }}
                >
                  <img
                    className="privacy-badge-menu__icon"
                    src={ICONS[key]}
                    alt=""
                    aria-hidden="true"
                  />
                  <span>{LABELS[key]}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        )}
      </span>
    );
  }

  return (
    <span
      className={`privacy-badge ${colorClass}${className ? ` ${className}` : ""}`}
      title={`${LABELS[privacy]} folder`}
    >
      <img
        className="privacy-badge__icon"
        src={ICONS[privacy]}
        alt=""
        aria-hidden="true"
      />
      <span className="sr-only">{LABELS[privacy]}</span>
    </span>
  );
}
