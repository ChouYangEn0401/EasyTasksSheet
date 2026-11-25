"""請求 body 的 pydantic 模型（對應 src/shared/*.ts 的 zod schema）。

慣例：選填但「不可為 null」的欄位寫成 `x: T = None`——預設值不經驗證，
所以未送時為 None，明確送 null 則驗證失敗（同 zod 的 `.optional()`）。
PATCH 以 model_fields_set 判斷有送來的欄位。
"""

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, StringConstraints

TAG_COLORS = ("gray", "blue", "purple", "green", "yellow", "orange", "red", "teal")
TagColor = Literal["gray", "blue", "purple", "green", "yellow", "orange", "red", "teal"]
TaskPriority = Literal["none", "low", "medium", "high", "urgent"]
PropertyType = Literal["text", "number", "select", "multi_select", "date", "checkbox", "url", "person"]

DATE_PATTERN = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
DateString = Annotated[str, StringConstraints(pattern=DATE_PATTERN)]


def trimmed(min_length: int, max_length: int) -> Any:
    return Annotated[str, StringConstraints(strip_whitespace=True, min_length=min_length, max_length=max_length)]


Username = trimmed(1, 64)
Name100 = trimmed(1, 100)
Title = trimmed(1, 500)


class _Input(BaseModel):
    model_config = {"extra": "ignore"}


# ── auth ──
class LoginInput(_Input):
    username: Username
    password: Annotated[str, StringConstraints(min_length=1, max_length=256)]


class ChangePasswordInput(_Input):
    currentPassword: Annotated[str, StringConstraints(min_length=1, max_length=256)]
    newPassword: Annotated[str, StringConstraints(min_length=8, max_length=256)]
    #: 新帳號：僅預設管理員首次重設時使用（格式於 handler 檢查，錯誤帶 field）
    username: Annotated[str, StringConstraints(max_length=64)] = None  # type: ignore[assignment]


# ── projects ──
class ProjectCreateInput(_Input):
    name: Name100
    color: TagColor = None  # type: ignore[assignment]


class ProjectUpdateInput(_Input):
    name: Name100 = None  # type: ignore[assignment]
    color: TagColor = None  # type: ignore[assignment]
    isArchived: bool = None  # type: ignore[assignment]
    sortOrder: float = None  # type: ignore[assignment]


# ── tasks ──
class TaskUpdateInput(_Input):
    title: Title = None  # type: ignore[assignment]
    projectId: int = None  # type: ignore[assignment]
    description: Annotated[str, StringConstraints(max_length=20_000)] = None  # type: ignore[assignment]
    statusId: int = None  # type: ignore[assignment]
    assigneeId: int | None = None
    priority: TaskPriority = None  # type: ignore[assignment]
    startDate: DateString | None = None
    dueDate: DateString | None = None
    estimateHours: Annotated[float, Field(ge=0)] | None = None
    progress: Annotated[int, Field(ge=0, le=100)] = None  # type: ignore[assignment]
    sortOrder: float = None  # type: ignore[assignment]
    custom: dict[str, Any] = None  # type: ignore[assignment]


class TaskCreateInput(TaskUpdateInput):
    title: Title


# ── properties ──
class SelectOption(_Input):
    id: Annotated[str, StringConstraints(min_length=1)]
    label: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    color: TagColor = None  # type: ignore[assignment]


class PropertyCreateInput(_Input):
    projectId: int | None = None
    name: Name100
    type: PropertyType
    options: list[SelectOption] = None  # type: ignore[assignment]


class PropertyUpdateInput(_Input):
    name: Name100 = None  # type: ignore[assignment]
    options: list[SelectOption] = None  # type: ignore[assignment]
    sortOrder: float = None  # type: ignore[assignment]


def dump_options(options: list[SelectOption] | None) -> list[dict[str, Any]]:
    return [o.model_dump(exclude_unset=True) for o in options or []]
