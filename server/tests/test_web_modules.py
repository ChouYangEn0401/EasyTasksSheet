"""前端模組的「窮人版連結器」：沒有建置步驟、沒有 TypeScript 之後，靠這支擋最常見的壞法。

- 每個相對 import 指到的檔必須存在（副檔名 .js）。
- 具名匯入在目標檔要找得到對應的 export（正則近似；`export * from` 的轉匯出會追進去）。
- 不得殘留舊世界的東西：`.ts'`、`from 'react'`、`@tanstack`、`zod`、`date-fns`、`import.meta`、`@dnd-kit`。
- 裸模組名只允許 import map 裡的三個：preact、preact/hooks、preact/compat。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

WEB_JS = Path(__file__).resolve().parents[2] / "web" / "static" / "js"
ALLOWED_BARE = {"preact", "preact/hooks", "preact/compat"}

_IMPORT_RE = re.compile(
    r"""^import\s+(?:(?P<default>[A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{(?P<names>[^}]*)\}|\*\s+as\s+\w+)?\s*from\s*['"](?P<spec>[^'"]+)['"]""",
    re.M,
)
_SIDE_EFFECT_IMPORT_RE = re.compile(r"""^import\s*['"](?P<spec>[^'"]+)['"]""", re.M)
_EXPORT_RE = re.compile(
    r"^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)", re.M
)
_EXPORT_LIST_RE = re.compile(r"^export\s*\{([^}]*)\}(?:\s*from\s*['\"]([^'\"]+)['\"])?", re.M)
_EXPORT_STAR_RE = re.compile(r"^export\s*\*\s*from\s*['\"]([^'\"]+)['\"]", re.M)
_EXPORT_DEFAULT_RE = re.compile(r"^export\s+default\b", re.M)


def _files() -> list[Path]:
    return sorted(p for p in WEB_JS.rglob("*.js") if not p.name.endswith(".test.js"))


def _strip_comments(text: str) -> str:
    # 先拿掉整行的 // 註解（裡面可能有 /api/x/* 這種看起來像區塊註解開頭的字），再拿掉區塊註解
    text = re.sub(r"^[ \t]*//.*$", "", text, flags=re.M)
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


_cache: dict[Path, set[str]] = {}


def exports_of(path: Path, seen: frozenset[Path] = frozenset()) -> set[str]:
    """一個模組對外的名字（含 export * 轉匯出）。"""
    if path in _cache:
        return _cache[path]
    if path in seen or not path.is_file():
        return set()
    text = _strip_comments(path.read_text(encoding="utf-8"))
    names: set[str] = set(_EXPORT_RE.findall(text))
    for inner, _src in _EXPORT_LIST_RE.findall(text):
        for item in inner.split(","):
            item = item.strip()
            if not item:
                continue
            names.add(item.split(" as ")[-1].strip())
    for src in _EXPORT_STAR_RE.findall(text):
        names |= exports_of((path.parent / src).resolve(), seen | {path})
    if _EXPORT_DEFAULT_RE.search(text):
        names.add("default")
    _cache[path] = names
    return names


def _imports(path: Path):
    text = _strip_comments(path.read_text(encoding="utf-8"))
    for m in _IMPORT_RE.finditer(text):
        names = [n.strip() for n in (m.group("names") or "").split(",") if n.strip()]
        names = [n.split(" as ")[0].strip() for n in names]
        if m.group("default"):
            names.append("default")
        yield m.group("spec"), names
    for m in _SIDE_EFFECT_IMPORT_RE.finditer(text):
        yield m.group("spec"), []


def test_web_js_directory_exists():
    assert (WEB_JS / "main.js").is_file(), "web/static/js/main.js 不存在"
    assert len(_files()) > 50


@pytest.mark.parametrize("path", _files(), ids=lambda p: str(p.relative_to(WEB_JS)))
def test_imports_resolve_and_names_exist(path: Path):
    problems: list[str] = []
    for spec, names in _imports(path):
        if not spec.startswith("."):
            if spec not in ALLOWED_BARE:
                problems.append(f"裸模組名不在 import map 裡：{spec}")
            continue
        target = (path.parent / spec).resolve()
        if not spec.endswith(".js"):
            problems.append(f"相對匯入必須帶 .js 副檔名：{spec}")
            continue
        if not target.is_file():
            problems.append(f"找不到檔案：{spec}")
            continue
        exported = exports_of(target)
        for n in names:
            if n not in exported:
                problems.append(f"{spec} 沒有匯出 {n}")
    assert not problems, "\n".join(problems)


@pytest.mark.parametrize("path", _files(), ids=lambda p: str(p.relative_to(WEB_JS)))
def test_no_leftovers_from_the_old_toolchain(path: Path):
    text = path.read_text(encoding="utf-8")
    # 只看 import 的來源（註解裡提到「取代了哪個函式庫」是允許的）
    specs = [spec for spec, _ in _imports(path)]
    bad = [s for s in specs if s.startswith(("react", "@tanstack", "zod", "date-fns", "@dnd-kit")) or s.endswith((".ts", ".tsx"))]
    if "import.meta" in text:
        bad.append("import.meta")
    if "__BLANK__" in text:
        bad.append("__BLANK__")
    assert not bad, f"殘留：{bad}"
