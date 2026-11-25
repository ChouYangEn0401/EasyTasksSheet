"""時區與日期的純函式（總覽、延遲鏈、匯報報告共用）。

不讀設定也不碰時鐘：呼叫端傳入 unix ms 與時區名稱（通常是 config.TZ，預設 Asia/Taipei）。
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone, tzinfo

#: 沒有 IANA 時區資料庫（Windows 未裝 tzdata）時的固定位移備援（皆無日光節約時間）
_FIXED_OFFSETS = {
    "Asia/Taipei": 8,
    "Asia/Shanghai": 8,
    "Asia/Hong_Kong": 8,
    "Asia/Singapore": 8,
    "Asia/Tokyo": 9,
    "UTC": 0,
    "Etc/UTC": 0,
}


def get_zone(name: str) -> tzinfo:
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(name)
    except Exception:
        hours = _FIXED_OFFSETS.get(name)
        if hours is None:
            raise
        return timezone(timedelta(hours=hours), name)


def date_in_zone(ms: int, time_zone: str) -> str:
    """某時區下的日期字串 YYYY-MM-DD"""
    return datetime.fromtimestamp(ms / 1000, tz=get_zone(time_zone)).date().isoformat()


def local_midnight_ms(d: date, zone: tzinfo) -> int:
    """某時區下該日 00:00 的 unix ms"""
    return int(datetime(d.year, d.month, d.day, tzinfo=zone).timestamp() * 1000)
