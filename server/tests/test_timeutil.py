"""server/app/timeutil.py：時區與日期純函式（總覽、延遲鏈、匯報報告共用）"""

from datetime import date, datetime

from server.app.timeutil import date_in_zone, get_zone, local_midnight_ms


def _ms(iso: str) -> int:
    return int(datetime.fromisoformat(iso).timestamp() * 1000)


def test_date_in_zone_crosses_midnight_by_zone():
    t = _ms("2026-01-04T16:30:00+00:00")  # 台北 2026-01-05 00:30
    assert date_in_zone(t, "Asia/Taipei") == "2026-01-05"
    assert date_in_zone(t, "UTC") == "2026-01-04"


def test_local_midnight_ms():
    zone = get_zone("Asia/Taipei")
    assert local_midnight_ms(date(2026, 1, 5), zone) == _ms("2026-01-05T00:00:00+08:00")
    assert local_midnight_ms(date(2026, 1, 5), get_zone("UTC")) == _ms("2026-01-05T00:00:00+00:00")
