"""Session dates come from the recording, never from its upload time."""
import re
from datetime import date, datetime, timezone


def nocturnal_activity_date(doc: dict) -> str | None:
    stored = doc.get("activity_date")
    if stored:
        try:
            return date.fromisoformat(str(stored)[:10]).isoformat()
        except ValueError:
            pass
    starts = []
    for window in doc.get("windows") or []:
        try:
            start = datetime.fromisoformat(str(window.get("tStart", "")).replace("Z", "+00:00"))
            starts.append(start.date())
            continue
        except (ValueError, TypeError):
            pass
        try:
            starts.append(datetime.fromtimestamp(float(window["tsMs"]) / 1000, timezone.utc).date())
        except (KeyError, ValueError, TypeError, OverflowError, OSError):
            pass
    return min(starts).isoformat() if starts else None


def nocturnal_session_name(doc: dict) -> str:
    name = doc.get("session_name") or ""
    activity_date = nocturnal_activity_date(doc)
    if not name or re.fullmatch(r"HRV Nocturno \d{1,2}/\d{1,2}/\d{4}(?: \d{2}:\d{2})?", name):
        return f"HRV Nocturno {date.fromisoformat(activity_date):%d/%m/%Y}" if activity_date else "HRV Nocturno · Fecha desconocida"
    return name
