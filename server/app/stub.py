"""路由共用常數。

（核心階段的「尚未實作 → 501」stub router 已隨各功能完成而移除；只留下 catch-all 路由用的方法清單。）
"""

from __future__ import annotations

#: catch-all 路由（/api 404、/api/admin 後備）註冊的 HTTP 方法
ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]
