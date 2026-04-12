#!/usr/bin/env python3
"""
healthkit_to_fit.py
-------------------
Converts an Apple Health export XML (or a fragment of it) that contains
HKQuantityTypeIdentifierHeartRate records into a valid .FIT file.

Usage:
    python healthkit_to_fit.py export.xml output.fit
    python healthkit_to_fit.py export.xml output.fit --source "Ultrahuman"
    python healthkit_to_fit.py export.xml output.fit --start "2026-04-12" --end "2026-04-12"
"""

import struct
import sys
import argparse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

# ── FIT constants ─────────────────────────────────────────────────────────────

# FIT epoch: Dec 31 1989 00:00:00 UTC
_FIT_EPOCH = datetime(1989, 12, 31, 0, 0, 0, tzinfo=timezone.utc)

# Base types used in field definitions
_UINT8  = 0x02
_UINT16 = 0x84
_UINT32 = 0x86
_ENUM   = 0x00

_CRC_TABLE = [
    0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
    0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
]


# ── CRC ───────────────────────────────────────────────────────────────────────

def _crc(data: bytes, crc: int = 0) -> int:
    for byte in data:
        tmp = _CRC_TABLE[crc & 0x0F]
        crc = (crc >> 4) & 0x0FFF
        crc ^= tmp ^ _CRC_TABLE[byte & 0x0F]
        tmp = _CRC_TABLE[crc & 0x0F]
        crc = (crc >> 4) & 0x0FFF
        crc ^= tmp ^ _CRC_TABLE[(byte >> 4) & 0x0F]
    return crc


# ── FIT helpers ───────────────────────────────────────────────────────────────

def _fit_ts(dt: datetime) -> int:
    """Datetime → FIT timestamp (seconds since FIT epoch)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int((dt - _FIT_EPOCH).total_seconds())


def _def_msg(local_type: int, global_num: int, fields: list) -> bytes:
    """Build a FIT definition message.
    fields: list of (field_def_number, size_bytes, base_type)
    """
    out = struct.pack("BB", 0x40 | local_type, 0x00)   # header + reserved
    out += struct.pack("<BH", 0x00, global_num)          # little-endian, global num
    out += struct.pack("B", len(fields))
    for fnum, fsize, ftype in fields:
        out += struct.pack("BBB", fnum, fsize, ftype)
    return out


def _data_msg(local_type: int, payload: bytes) -> bytes:
    return struct.pack("B", local_type) + payload


def _file_header(data_size: int) -> bytes:
    """Build a 14-byte FIT file header."""
    hdr = struct.pack(
        "<BBHHI",
        14,          # header size
        0x10,        # protocol version 1.0
        2132,        # profile version (FIT 21.32)
        data_size,   # bytes of data that follow (excl. header and file CRC)
    ) + b".FIT"
    hdr_crc = _crc(hdr)
    return hdr + struct.pack("<H", hdr_crc)


# ── Apple Health XML reader ───────────────────────────────────────────────────

def _parse_healthkit(xml_bytes: bytes, source_filter: str | None = None,
                     start: datetime | None = None, end: datetime | None = None
                     ) -> list[tuple[datetime, int]]:
    """
    Parse HKQuantityTypeIdentifierHeartRate records from an Apple Health export.
    Returns sorted list of (datetime_utc, bpm).
    """
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        # The user may have pasted a fragment — wrap it
        xml_bytes = b"<root>" + xml_bytes + b"</root>"
        root = ET.fromstring(xml_bytes)

    records = []
    # Support both top-level <HealthData> and wrapped fragments
    candidates = root.iter("Record")

    for rec in candidates:
        if rec.get("type") != "HKQuantityTypeIdentifierHeartRate":
            continue
        if source_filter and rec.get("sourceName") != source_filter:
            continue

        start_str = rec.get("startDate") or rec.get("endDate")
        value_str  = rec.get("value")
        if not start_str or not value_str:
            continue

        try:
            bpm = int(float(value_str))
            # Apple dates: "2026-04-12 17:10:14 +0200"
            dt = datetime.strptime(start_str, "%Y-%m-%d %H:%M:%S %z").astimezone(timezone.utc)
        except (ValueError, OverflowError):
            continue

        if start and dt < start:
            continue
        if end and dt > end:
            continue

        records.append((dt, bpm))

    records.sort(key=lambda x: x[0])
    return records


# ── FIT writer ────────────────────────────────────────────────────────────────

def build_fit(records: list[tuple[datetime, int]]) -> bytes:
    """
    Build a minimal FIT activity file containing only heart rate records.
    Local message type 0 → file_id (global 0)
    Local message type 1 → record  (global 20)
    """
    if not records:
        raise ValueError("No hay registros de FC para escribir.")

    data = b""

    # ── file_id definition (local 0, global 0) ──
    #   field 0  type          enum   1 byte
    #   field 1  manufacturer  uint16 2 bytes
    #   field 4  time_created  uint32 4 bytes
    data += _def_msg(0, 0, [(0, 1, _ENUM), (1, 2, _UINT16), (4, 4, _UINT32)])

    # ── file_id data ──
    time_created = _fit_ts(records[0][0])
    data += _data_msg(0, struct.pack("<BHI", 4, 255, time_created))
    # 4 = activity file type, 255 = development/unknown manufacturer

    # ── record definition (local 1, global 20) ──
    #   field 253  timestamp   uint32 4 bytes
    #   field 3    heart_rate  uint8  1 byte
    data += _def_msg(1, 20, [(253, 4, _UINT32), (3, 1, _UINT8)])

    # ── record data ──
    for dt, bpm in records:
        ts = _fit_ts(dt)
        data += _data_msg(1, struct.pack("<IB", ts, bpm))

    # Assemble: header + data + file CRC
    header   = _file_header(len(data))
    file_crc = struct.pack("<H", _crc(data))
    return header + data + file_crc


# ── CLI ───────────────────────────────────────────────────────────────────────

def convert(input_path: str, output_path: str,
            source: str | None = None,
            start: str | None = None,
            end: str | None = None) -> int:
    with open(input_path, "rb") as f:
        xml_bytes = f.read()

    start_dt = datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=timezone.utc) if start else None
    end_dt   = (datetime.strptime(end, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                + timedelta(days=1)) if end else None

    records = _parse_healthkit(xml_bytes, source_filter=source,
                               start=start_dt, end=end_dt)
    if not records:
        print("ERROR: No se encontraron registros de FC con los filtros indicados.", file=sys.stderr)
        return 1

    fit_bytes = build_fit(records)

    with open(output_path, "wb") as f:
        f.write(fit_bytes)

    duration = (records[-1][0] - records[0][0]).total_seconds() / 60
    print(f"OK — {len(records)} muestras · {duration:.1f} min → {output_path}")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convierte Apple Health XML a FIT")
    parser.add_argument("input",  help="Archivo XML de Apple Health")
    parser.add_argument("output", help="Archivo .fit de salida")
    parser.add_argument("--source", help="Filtrar por nombre de fuente (ej: Ultrahuman)")
    parser.add_argument("--start",  help="Fecha inicio YYYY-MM-DD (opcional)")
    parser.add_argument("--end",    help="Fecha fin   YYYY-MM-DD (opcional)")
    args = parser.parse_args()
    sys.exit(convert(args.input, args.output,
                     source=args.source, start=args.start, end=args.end))
