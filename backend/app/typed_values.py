import re
import unicodedata
from datetime import datetime, timezone
from itertools import islice
from typing import Any, Dict, Iterable, Optional


INTERNAL_TYPED_KEY = "__typed__"
NULL_VALUES = {"null", "none", "na", "n/a", "nan", "-", ""}

_NUMBER_CLEAN_RE = re.compile(r"[$€£¥₹,\s]")
_NUMBER_VALID_RE = re.compile(r"^[-+]?\d*\.?\d+$")
_ISO_DATE_RE = re.compile(
    r"^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$"
)
_DMY_OR_MDY_RE = re.compile(
    r"^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$"
)


def is_internal_key(key: str) -> bool:
    return key.startswith("__")


def normalize_text_value(value: Any) -> Optional[str]:
    if value is None:
        return None
    value_str = unicodedata.normalize("NFC", str(value))
    value_str = value_str.replace("\xa0", " ")
    value_str = " ".join(value_str.split())
    if value_str.lower() in NULL_VALUES:
        return None
    return value_str


def parse_number(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)

    raw = str(value).strip()
    if not raw:
        return None
    lowered = raw.lower()
    if lowered in {"na", "n/a", "nan", "none", "null"}:
        return None
    # Guard against date-like tokens (e.g. 01/08/2022) being misclassified as numbers.
    if _ISO_DATE_RE.match(raw) or _DMY_OR_MDY_RE.match(raw):
        return None

    is_negative_parentheses = raw.startswith("(") and raw.endswith(")")
    if is_negative_parentheses:
        raw = raw[1:-1].strip()

    raw = _NUMBER_CLEAN_RE.sub("", raw)

    multiplier = 1.0
    if raw and raw[-1].lower() in {"k", "m", "b"}:
        suffix = raw[-1].lower()
        raw = raw[:-1]
        if suffix == "k":
            multiplier = 1_000.0
        elif suffix == "m":
            multiplier = 1_000_000.0
        else:
            multiplier = 1_000_000_000.0

    if raw.endswith("%"):
        raw = raw[:-1]

    raw = re.sub(r"[^0-9.\-+]", "", raw)
    if not _NUMBER_VALID_RE.match(raw):
        return None

    try:
        parsed = float(raw) * multiplier
    except ValueError:
        return None

    if is_negative_parentheses:
        parsed *= -1.0
    return parsed


def infer_date_orders(
    headers: list[str],
    rows_iter: Iterable[list[str]],
    sample_size: int = 800,
) -> Dict[str, str]:
    """Infer ambiguous date order per column ("dmy" or "mdy") from sampled rows."""
    sample_rows = list(islice(rows_iter, max(0, int(sample_size))))
    if not sample_rows:
        return {}

    score_dmy: Dict[str, int] = {h: 0 for h in headers}
    score_mdy: Dict[str, int] = {h: 0 for h in headers}

    for row in sample_rows:
        for i, column in enumerate(headers):
            raw = row[i] if i < len(row) else None
            normalized = normalize_text_value(raw)
            if normalized is None:
                continue
            match = _DMY_OR_MDY_RE.match(str(normalized))
            if not match:
                continue
            a = int(match.group(1))
            b = int(match.group(2))
            if a > 12 and b <= 12:
                score_dmy[column] += 3
            elif b > 12 and a <= 12:
                score_mdy[column] += 3
            elif a <= 12 and b <= 12:
                # Ambiguous rows are weak evidence.
                score_dmy[column] += 1
                score_mdy[column] += 1

    out: Dict[str, str] = {}
    for column in headers:
        if score_mdy[column] > score_dmy[column]:
            out[column] = "mdy"
        else:
            out[column] = "dmy"
    return out


def parse_date(value: Any, ambiguous_order: str = "dmy") -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None

    iso_match = _ISO_DATE_RE.match(text)
    if iso_match:
        year = int(iso_match.group(1))
        month = int(iso_match.group(2))
        day = int(iso_match.group(3))
        try:
            parsed = datetime(year, month, day, tzinfo=timezone.utc)
            return {"iso_date": parsed.date().isoformat(), "epoch_seconds": int(parsed.timestamp())}
        except ValueError:
            return None

    dmy_or_mdy = _DMY_OR_MDY_RE.match(text)
    if dmy_or_mdy:
        a = int(dmy_or_mdy.group(1))
        b = int(dmy_or_mdy.group(2))
        year_raw = int(dmy_or_mdy.group(3))
        year = year_raw + 2000 if year_raw < 100 else year_raw

        prefer_mdy = ambiguous_order == "mdy"
        day = a
        month = b
        if a <= 12 and b > 12:
            month = a
            day = b
        elif a <= 12 and b <= 12:
            if prefer_mdy:
                month = a
                day = b
            else:
                day = a
                month = b

        try:
            parsed = datetime(year, month, day, tzinfo=timezone.utc)
            return {
                "iso_date": parsed.date().isoformat(),
                "epoch_seconds": int(parsed.timestamp()),
                "year": parsed.year,
                "month": parsed.month,
                "day": parsed.day,
            }
        except ValueError:
            return None

    try:
        parsed_epoch = datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)
        return {
            "iso_date": parsed_epoch.date().isoformat(),
            "epoch_seconds": int(parsed_epoch.timestamp()),
            "year": parsed_epoch.year,
            "month": parsed_epoch.month,
            "day": parsed_epoch.day,
        }
    except ValueError:
        return None


def normalize_row_obj(
    headers: list[str],
    row: list[str],
    date_orders: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    typed: Dict[str, Dict[str, Any]] = {}

    for i in range(len(headers)):
        key = headers[i]
        normalized = normalize_text_value(row[i] if i < len(row) else None)
        result[key] = normalized
        if normalized is None:
            continue

        date_value = parse_date(normalized, ambiguous_order=(date_orders or {}).get(key, "dmy"))
        if date_value is not None:
            typed[key] = {"type": "date", **date_value}
            continue

        numeric_value = parse_number(normalized)
        if numeric_value is not None:
            typed[key] = {"type": "number", "number": numeric_value}

    if typed:
        result[INTERNAL_TYPED_KEY] = typed
    return result


def get_typed_value(row_data: Dict[str, Any], column: str) -> Optional[Dict[str, Any]]:
    typed = row_data.get(INTERNAL_TYPED_KEY)
    if not isinstance(typed, dict):
        return None
    item = typed.get(column)
    if not isinstance(item, dict):
        return None
    return item


def get_numeric_value(row_data: Dict[str, Any], column: str) -> Optional[float]:
    typed = get_typed_value(row_data, column)
    if typed and typed.get("type") == "number":
        raw = typed.get("number")
        try:
            return float(raw)
        except (TypeError, ValueError):
            return None
    return parse_number(row_data.get(column))


def get_date_epoch_seconds(row_data: Dict[str, Any], column: str) -> Optional[int]:
    typed = get_typed_value(row_data, column)
    if typed and typed.get("type") == "date":
        raw = typed.get("epoch_seconds")
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None
    parsed = parse_date(row_data.get(column))
    if not parsed:
        return None
    try:
        return int(parsed.get("epoch_seconds"))
    except (TypeError, ValueError):
        return None


def strip_internal_fields(row_data: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in row_data.items() if not is_internal_key(k)}
