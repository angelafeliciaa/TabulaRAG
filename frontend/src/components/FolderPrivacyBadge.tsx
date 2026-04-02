import type { FolderPrivacy } from "../api";

const LABELS: Record<FolderPrivacy, string> = {
  public: "Public",
  protected: "Protected",
  private: "Private",
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

  if (onChange) {
    return (
      <select
        className={`privacy-badge privacy-badge--select ${colorClass}${className ? ` ${className}` : ""}`}
        value={privacy}
        disabled={disabled}
        aria-label="Folder privacy"
        onChange={(e) => onChange(e.target.value as FolderPrivacy)}
      >
        <option value="public">Public</option>
        <option value="protected">Protected</option>
        <option value="private">Private</option>
      </select>
    );
  }

  return (
    <span
      className={`privacy-badge ${colorClass}${className ? ` ${className}` : ""}`}
      title={`${LABELS[privacy]} folder`}
    >
      <span className="privacy-badge__dot" aria-hidden="true" />
      {LABELS[privacy]}
    </span>
  );
}
