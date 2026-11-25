"""解析使用者貼上的 `git worktree list` 輸出（純函式：不執行任何程式、不碰檔案系統）。

支援：
- 預設格式：`<path>  <sha> [<branch>]`、`(detached HEAD)`、`(bare)`，結尾旗標 `locked [原因]`、`prunable [原因]`；
  `--verbose` 的縮排續行（`locked: 原因` / `prunable: 原因`）
- `--porcelain`（含 `-z`，NUL 視同換行）：`worktree <path>` 區塊，`HEAD`、`branch refs/heads/..`、`detached`、`bare`、
  `locked [原因]`、`prunable [原因]`
- 忽略空行與命令提示字元行（`C:\\x>git worktree list`、`PS C:\\x> git ...`、`$ git ...`）；其餘無法辨識的行放進 `unparsed`
路徑可含空白 / 中文 / 反斜線：以「路徑 + 空白 + 7–40 位十六進位 sha + 空白 + `[`／`(`」為邊界解析，不用空白切。
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

MAX_BYTES = 200_000
MAX_ENTRIES = 500
#: 回傳的無法辨識行上限（避免回應過大）
MAX_UNPARSED = 100
_MAX_LINE = 2000


class PasteError(ValueError):
    """輸入不合法（太大 / 空白）；message 為可直接顯示給使用者的中文"""


@dataclass
class ParsedWorktree:
    path: str
    sha: str | None
    branch: str | None
    isDetached: bool
    isBare: bool
    isLocked: bool
    isPrunable: bool
    lineNo: int
    isMain: bool
    lockReason: str = ""
    prunableReason: str = ""
    #: 可能是暫時性 / 代理產生的原因（提示用，非判決）
    tempReasons: list[str] = field(default_factory=list)

    @property
    def isTemp(self) -> bool:
        return bool(self.tempReasons)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["isTemp"] = self.isTemp
        return d


@dataclass
class ParseResult:
    entries: list[ParsedWorktree]
    unparsed: list[dict[str, Any]]
    unparsedCount: int
    truncated: bool
    repo: str


_PROMPT = re.compile(r"^\s*(?:PS\s+)?(?:.*?>|[$#%])\s*git(?:\s.*)?$|^\s*(?:PS\s+)?[A-Za-z]:.*>\s*$", re.I)
_PORC_START = re.compile(r"^worktree\s+(\S.*)$")
_LINE = re.compile(
    r"^(?P<path>\S.*?)\s+(?P<sha>[0-9a-fA-F]{7,40})\s+(?P<ref>\[[^\]\r\n]*\]|\(detached HEAD\)|\(bare\))(?P<tail>.*)$"
)
_BARE_LINE = re.compile(r"^(?P<path>\S.*?)\s+\(bare\)(?P<tail>.*)$")
_FLAG = re.compile(r"^\s*(locked|prunable)(?:\s+(.*))?$")
_VERBOSE = re.compile(r"^(locked|prunable)\s*:\s*(.*)$")
_SHA = re.compile(r"^[0-9a-fA-F]{7,64}$")


def norm(path: str) -> str:
    """比對用：反斜線轉正斜線、小寫、去結尾斜線"""
    s = path.strip().replace("\\", "/").lower()
    return s.rstrip("/") if len(s) > 1 else s


def folder_name(path: str) -> str:
    parts = [p for p in path.strip().replace("\\", "/").split("/") if p]
    return parts[-1] if parts else ""


_TEMP_PATH_RULES = (
    ("/.claude/worktrees/", "路徑在 .claude/worktrees（代理工作樹）"),
    ("/scratchpad/", "路徑在 scratchpad"),
    ("/appdata/local/temp/", "路徑在 AppData/Local/Temp"),
    ("/tmp/", "路徑在 tmp"),
)


def temp_reasons(path: str, branch: str | None, is_detached: bool) -> list[str]:
    """可能是暫時性 / 代理產生的提示（只是提示；使用者可自行勾選）"""
    p = "/" + norm(path).lstrip("/") + "/"
    out = [msg for needle, msg in _TEMP_PATH_RULES if needle in p]
    if folder_name(path).lower().startswith("agent-"):
        out.append("資料夾名稱以 agent- 開頭")
    if (branch or "").startswith("worktree-agent-"):
        out.append("分支名稱以 worktree-agent- 開頭")
    if is_detached and "/appdata/local/temp/" in p:
        out.append("位於 Temp 的分離 HEAD")
    return out


def _apply_tail(e: ParsedWorktree, tail: str) -> bool:
    """解析結尾旗標；回傳 False 表示結尾含無法辨識的內容"""
    rest = tail.strip()
    while rest:
        m = _FLAG.match(rest)
        if not m:
            return False
        kind, reason = m.group(1), (m.group(2) or "").strip()
        # 原因的第一個字若是另一個旗標關鍵字（如 `locked prunable`），視為旗標
        nxt = _FLAG.match(reason) if reason else None
        if nxt and not nxt.group(2) and reason in ("locked", "prunable") and reason != kind:
            reason, rest = "", reason
        else:
            rest = ""
        if kind == "locked":
            e.isLocked, e.lockReason = True, reason
        else:
            e.isPrunable, e.prunableReason = True, reason
    return True


def _strip_branch(ref: str) -> str:
    for p in ("refs/heads/", "heads/"):
        if ref.startswith(p):
            return ref[len(p) :]
    return ref


def guess_repo(entries: list[ParsedWorktree]) -> str:
    """推測 repo 名稱：第一筆（主 worktree）的資料夾名稱；bare 去掉 .git"""
    if not entries:
        return ""
    name = folder_name(entries[0].path)
    return name[:-4] if name.lower().endswith(".git") and len(name) > 4 else name


def parse_worktree_list(text: str) -> ParseResult:
    if len(text.encode("utf-8", "ignore")) > MAX_BYTES:
        raise PasteError(f"貼上的內容太大（上限 {MAX_BYTES // 1000} KB）")
    text = text.replace("\0", "\n").lstrip("\ufeff")
    if not text.strip():
        raise PasteError("請貼上 git worktree list 的輸出")

    entries: list[ParsedWorktree] = []
    unparsed: list[dict[str, Any]] = []
    unparsed_n = 0
    truncated = False
    block: ParsedWorktree | None = None  # 目前的 porcelain 區塊
    last: ParsedWorktree | None = None

    def bad(no: int, raw: str) -> None:
        nonlocal unparsed_n
        unparsed_n += 1
        if len(unparsed) < MAX_UNPARSED:
            unparsed.append({"lineNo": no, "text": raw.strip()[:_MAX_LINE]})

    def add(e: ParsedWorktree) -> bool:
        nonlocal truncated
        if len(entries) >= MAX_ENTRIES:
            truncated = True
            return False
        e.isMain = not entries
        entries.append(e)
        return True

    for no, raw in enumerate(text.splitlines(), 1):
        line = raw.rstrip()
        s = line.strip()
        if not s:
            block = None
            continue
        if len(s) > _MAX_LINE:
            bad(no, s)
            continue
        # ── porcelain 區塊內 ──
        if block is not None and not _PORC_START.match(s):
            key, _, val = s.partition(" ")
            val = val.strip()
            if key == "HEAD" and _SHA.match(val):
                block.sha = val.lower()
            elif key == "branch" and val:
                block.branch = _strip_branch(val)
            elif key == "detached" and not val:
                block.isDetached = True
            elif key == "bare" and not val:
                block.isBare = True
            elif key in ("locked", "prunable"):
                if key == "locked":
                    block.isLocked, block.lockReason = True, val
                else:
                    block.isPrunable, block.prunableReason = True, val
            else:
                bad(no, s)
            continue
        m = _PORC_START.match(s)
        if m:
            path = m.group(1).strip()
            e = ParsedWorktree(path, None, None, False, False, False, False, no, False)
            if add(e):
                block = e
                last = e
            else:
                block = None
                last = None
            continue
        if _PROMPT.match(s):
            continue
        # ── --verbose 的縮排續行 ──
        if raw[:1] in (" ", "\t") and last is not None:
            vm = _VERBOSE.match(s)
            if vm:
                if vm.group(1) == "locked":
                    last.isLocked, last.lockReason = True, vm.group(2).strip()
                else:
                    last.isPrunable, last.prunableReason = True, vm.group(2).strip()
                continue
        # ── 預設格式 ──
        m = _LINE.match(s)
        if m:
            ref = m.group("ref")
            e = ParsedWorktree(
                m.group("path").strip(), m.group("sha").lower(), None, False, False, False, False, no, False
            )
            if ref == "(detached HEAD)":
                e.isDetached = True
            elif ref == "(bare)":
                e.isBare = True
            else:
                e.branch = ref[1:-1].strip() or None
            if not _apply_tail(e, m.group("tail")):
                bad(no, s)
                last = None
                continue
            last = e if add(e) else None
            continue
        m = _BARE_LINE.match(s)
        if m:
            e = ParsedWorktree(m.group("path").strip(), None, None, False, True, False, False, no, False)
            if not _apply_tail(e, m.group("tail")):
                bad(no, s)
                last = None
                continue
            last = e if add(e) else None
            continue
        bad(no, s)

    for e in entries:
        e.tempReasons = temp_reasons(e.path, e.branch, e.isDetached)
    return ParseResult(entries, unparsed, unparsed_n, truncated, guess_repo(entries))
