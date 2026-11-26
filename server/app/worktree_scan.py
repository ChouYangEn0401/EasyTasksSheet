"""掃描本機專案的 git worktree（網頁「掃描本機專案」與 `python -m server.cli scan-worktrees` 共用）。

安全原則（docs/design/eng-tracking.md §掃描）：
- 網頁掃描只允許 WORKTREE_SCAN_ROOTS 內的資料夾；以真實路徑（realpath，解開 `..` 與符號連結）比對，
  未設定時整個功能停用。CLI 由操作者在自己電腦上直接執行，不受此限制。
- git 一律以參數陣列執行（不經 shell）、有逾時；以 `-c` 關閉 fsmonitor / hooks / pager / 外部 diff 等
  可能執行外部程式的設定，`GIT_OPTIONAL_LOCKS=0`（不寫入 index）、`GIT_TERMINAL_PROMPT=0`；
  環境變數只帶白名單；只用唯讀指令（worktree list、status、rev-list、merge-base、log、rev-parse、reflog），
  不 fetch、不執行 hook。輸出長度與 worktree 數量有上限。
- 電腦識別碼（machine_id）存在使用者家目錄 `~/.tasks-sheets/machine.json`（與 scripts/report_worktrees.py 共用）。
"""

from __future__ import annotations

import json
import os
import re
import secrets
import socket
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

#: 單次掃描最多處理的 worktree 數
MAX_WORKTREES = 200
#: 單一 git 指令的輸出上限（位元組）
MAX_OUTPUT = 1_000_000

#: 關閉可能執行外部程式 / 寫入的設定（加在每個 git 指令最前面）
SAFE_CONFIG = (
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=",
    "-c", "core.pager=cat",
    "-c", "pager.status=false",
    "-c", "diff.external=",
    "-c", "core.sshCommand=",
    "-c", "credential.helper=",
    "-c", "protocol.allow=never",
    "-c", "core.untrackedCache=false",
    "-c", "status.submoduleSummary=false",
    "-c", "submodule.recurse=false",
    "-c", "gc.auto=0",
    "--no-optional-locks",
)  # fmt: skip

#: 傳給 git 的環境變數白名單（其餘一律不帶）
_ENV_ALLOW = (
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
    "TEMP",
    "TMP",
    "TMPDIR",
)


class ScanError(Exception):
    def __init__(self, message: str, code: str = "SCAN_ERROR"):
        super().__init__(message)
        self.message = message
        self.code = code


# ── 允許的資料夾 ──


def parse_roots(raw: str | None) -> list[Path]:
    """WORKTREE_SCAN_ROOTS（逗號分隔）→ 真實路徑清單；不存在的資料夾略過"""
    roots: list[Path] = []
    for part in (raw or "").split(","):
        p = part.strip()
        if not p:
            continue
        try:
            real = Path(os.path.realpath(os.path.expanduser(p)))
        except (OSError, ValueError):
            continue
        if real.is_dir() and real not in roots:
            roots.append(real)
    return roots


def _norm(p: Path) -> str:
    return os.path.normcase(os.path.normpath(str(p)))


def is_within(path: Path, root: Path) -> bool:
    """path 是否為 root 本身或其子路徑（兩者皆應為真實路徑；Windows 不分大小寫）"""
    a, b = _norm(path), _norm(root)
    return a == b or a.startswith(b.rstrip(os.sep) + os.sep)


def resolve_target(raw: str, roots: list[Path] | None) -> Path:
    """使用者輸入的資料夾 → 真實路徑；roots 不為 None 時必須位於其中之一（防 `..` 與符號連結逃逸）"""
    text = (raw or "").strip().strip('"')
    if not text or len(text) > 1000 or "\0" in text:
        raise ScanError("請輸入專案資料夾路徑", "SCAN_BAD_PATH")
    p = Path(os.path.expanduser(text))
    if not p.is_absolute():
        raise ScanError("請輸入完整的資料夾路徑（絕對路徑）", "SCAN_BAD_PATH")
    try:
        real = Path(os.path.realpath(p))
    except (OSError, ValueError):
        raise ScanError("無法解析此路徑", "SCAN_BAD_PATH") from None
    if roots is not None and not any(is_within(real, r) for r in roots):
        raise ScanError("此資料夾不在允許掃描的範圍內（WORKTREE_SCAN_ROOTS）", "SCAN_OUTSIDE_ROOTS")
    if not real.is_dir():
        raise ScanError("找不到此資料夾", "SCAN_NOT_FOUND")
    return real


# ── git 執行 ──


def _env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k.upper() in _ENV_ALLOW}
    env.update(
        GIT_OPTIONAL_LOCKS="0",
        GIT_TERMINAL_PROMPT="0",
        GIT_PAGER="cat",
        PAGER="cat",
        GIT_ASKPASS="",
        SSH_ASKPASS="",
        GCM_INTERACTIVE="never",
        GIT_NO_REPLACE_OBJECTS="1",
        LC_ALL="C",
    )
    return env


@dataclass
class GitResult:
    code: int
    out: str


class Git:
    """以參數陣列執行唯讀 git 指令（無 shell、有逾時、輸出上限）"""

    #: 允許的子指令（防止誤用為任意 git 執行器）
    ALLOWED = frozenset({"worktree", "status", "rev-list", "merge-base", "log", "rev-parse", "reflog"})

    def __init__(self, timeout_ms: int = 10_000, executable: str = "git"):
        self.timeout = max(1, timeout_ms) / 1000
        self.executable = executable

    def run(self, cwd: Path, *args: str) -> GitResult:
        if not args or args[0] not in self.ALLOWED:
            raise ScanError(f"不允許的 git 指令：{args[:1]}")
        if args[0] == "worktree" and args[1:2] != ("list",):
            raise ScanError("只允許 git worktree list")
        try:
            proc = subprocess.run(
                [self.executable, *SAFE_CONFIG, "-C", str(cwd), *args],
                capture_output=True,
                timeout=self.timeout,
                env=_env(),
                shell=False,
                stdin=subprocess.DEVNULL,
                check=False,
            )
        except FileNotFoundError:
            raise ScanError("找不到 git 執行檔", "SCAN_NO_GIT") from None
        except subprocess.TimeoutExpired:
            raise ScanError(f"git 執行逾時（{int(self.timeout * 1000)}ms）", "SCAN_TIMEOUT") from None
        if len(proc.stdout) > MAX_OUTPUT:
            raise ScanError("git 輸出過長，已中止掃描", "SCAN_TOO_LARGE")
        return GitResult(proc.returncode, proc.stdout.decode("utf-8", errors="replace"))

    def ok(self, cwd: Path, *args: str) -> str | None:
        r = self.run(cwd, *args)
        return r.out if r.code == 0 else None


# ── 解析與偵測 ──


def normalize_path(p: str) -> str:
    """與 report_worktrees.py 相同：正斜線、去除結尾斜線"""
    n = p.strip().replace("\\", "/")
    while len(n) > 1 and n.endswith("/") and not re.fullmatch(r"[a-zA-Z]:/", n):
        n = n[:-1]
    return n


def parse_porcelain(text: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line:
            if cur:
                entries.append(cur)
            cur = None
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            if cur:
                entries.append(cur)
            cur = {"path": normalize_path(value), "head": None, "branch": None, "bare": False, "prunable": False, "detached": False}
        elif cur is not None:
            if key == "HEAD":
                cur["head"] = value or None
            elif key == "branch":
                cur["branch"] = re.sub(r"^refs/heads/", "", value) or None
            elif key == "bare":
                cur["bare"] = True
            elif key == "detached":
                cur["detached"] = True
            elif key == "prunable":
                cur["prunable"] = True
    if cur:
        entries.append(cur)
    return entries


@dataclass
class ScannedWorktree:
    path: str
    branch: str | None
    headSha: str | None
    isDirty: bool = False
    ahead: int | None = None
    behind: int | None = None
    isMerged: bool = False
    lastCommitAt: int | None = None
    isPrunable: bool = False
    isDetached: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ScanResult:
    repoPath: str
    repo: str
    base: str | None
    worktrees: list[ScannedWorktree] = field(default_factory=list)
    truncated: bool = False


_SHA = re.compile(r"^[0-9a-f]{7,64}$")


def _base_branch(git: Git, repo: Path) -> str | None:
    for name in ("main", "master"):
        if git.ok(repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{name}") is not None:
            return name
    return None


def _has_own_history(git: Git, repo: Path, branch: str) -> bool:
    """分支是否曾有自己的提交（區分「已併入」與「剛建立尚未提交」）"""
    out = git.ok(repo, "reflog", "show", "--format=%gs", f"refs/heads/{branch}", "--")
    if out is None:
        return True
    lines = [l for l in out.splitlines() if l.strip()]
    return not lines or any(not l.startswith("branch: Created from") for l in lines)


def scan_repo(target: Path, git: Git | None = None, repo_name: str | None = None) -> ScanResult:
    """掃描 target（專案資料夾或其任一 worktree）所屬 repo 的所有 worktree（不含主工作目錄）"""
    git = git or Git()
    top = git.run(target, "rev-parse", "--show-toplevel")
    if top.code != 0:
        raise ScanError("此資料夾不是 git 專案", "SCAN_NOT_GIT")
    listing = git.run(target, "worktree", "list", "--porcelain")
    if listing.code != 0:
        raise ScanError("讀取 worktree 清單失敗", "SCAN_GIT_FAILED")
    entries = parse_porcelain(listing.out)
    if not entries:
        raise ScanError("讀取 worktree 清單失敗", "SCAN_GIT_FAILED")
    main_path = Path(entries[0]["path"]) if not entries[0]["bare"] else Path(top.out.strip())
    repo = repo_name or main_path.name or Path(top.out.strip()).name
    base = _base_branch(git, target)
    targets = [e for e in entries[1:] if not e["bare"]]
    truncated = len(targets) > MAX_WORKTREES
    result = ScanResult(repoPath=normalize_path(str(main_path)), repo=repo, base=base, truncated=truncated)
    for e in targets[:MAX_WORKTREES]:
        head = e["head"] if e["head"] and _SHA.match(e["head"]) else None
        exists = Path(e["path"]).is_dir()
        w = ScannedWorktree(
            path=e["path"],
            branch=e["branch"],
            headSha=head,
            isPrunable=e["prunable"] or not exists,
            isDetached=e["detached"],
        )
        result.worktrees.append(w)
        if not head:
            continue
        if exists:
            st = git.run(Path(e["path"]), "status", "--porcelain", "--ignore-submodules=all")
            w.isDirty = st.code == 0 and st.out.strip() != ""
        ct = git.ok(target, "log", "-1", "--format=%ct", head)
        if ct and ct.strip().isdigit():
            w.lastCommitAt = int(ct.strip()) * 1000
        if base:
            counts = git.ok(target, "rev-list", "--left-right", "--count", f"refs/heads/{base}...{head}")
            parts = (counts or "").split()
            if len(parts) == 2 and all(x.isdigit() for x in parts):
                w.behind, w.ahead = int(parts[0]), int(parts[1])
            if e["branch"] and e["branch"] != base:
                anc = git.run(target, "merge-base", "--is-ancestor", head, f"refs/heads/{base}")
                w.isMerged = anc.code == 0 and _has_own_history(git, target, e["branch"])
    return result


# ── 本機電腦識別碼（~/.tasks-sheets/machine.json；與 report_worktrees.py 共用） ──

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def machine_config_path(home: str | None = None) -> Path:
    base = home or os.environ.get("TASKS_SHEETS_HOME") or os.path.join(os.path.expanduser("~"), ".tasks-sheets")
    return Path(base) / "machine.json"


def local_machine(create: bool = False, home: str | None = None) -> dict[str, str | None]:
    """{"machineId", "machineName"}。檔案不存在時：create=True 產生隨機 id 並寫入；否則 id 為 None。
    名稱預設為主機名稱（可直接編輯 machine.json 改名；伺服器以 id 為鍵，改名不影響比對）"""
    path = machine_config_path(home)
    data: dict[str, Any] = {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    mid = data.get("machineId")
    name = data.get("machineName")
    if not isinstance(mid, str) or not _ID_RE.match(mid):
        mid = None
    if not isinstance(name, str) or not name.strip():
        name = socket.gethostname() or "本機"
    if mid is None and create:
        mid = secrets.token_hex(16)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"machineId": mid, "machineName": name}, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass
    return {"machineId": mid, "machineName": name.strip()[:100]}


def valid_machine_id(v: str | None) -> bool:
    return bool(v and _ID_RE.match(v))
