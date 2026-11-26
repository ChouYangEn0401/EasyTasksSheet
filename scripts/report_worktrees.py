#!/usr/bin/env python3
"""在「各人自己的電腦」執行：讀取本機 repo 的 `git worktree list`，連同 dirty / ahead / behind / 是否已併入 main，
回報給 server 集中保存（POST /api/eng/worktrees/report）。server 端不執行任何 git 指令；
頁面上與手動紀錄的比對（可能遺失 / 未登記）只是參考提示。

用法：
  python scripts/report_worktrees.py --server https://tasks.example.com [--path <repo 路徑>] [--machine <電腦名稱>] [--repo <repo 名稱>] [--dry-run]
環境變數：
  WORKTREE_REPORT_TOKEN  回報 token（與 server 的設定相同；回報端點免登入，只以此 token 驗證）
  GIT_TIMEOUT_MS         git 指令逾時（預設 10000）
  TASKS_SHEETS_HOME      電腦識別設定檔所在資料夾（預設 ~/.tasks-sheets）
電腦識別：第一次執行時在 ~/.tasks-sheets/machine.json 產生隨機 machineId（之後固定）與可編輯的 machineName。
伺服器以 machineId 區分電腦，改名或兩台同名都不會混淆。
安全：空清單或筆數驟減的回報會被伺服器攔下（保留舊資料），需有人在頁面上確認才採用；伺服器不會因回報而刪除任何紀錄。
只依賴 Python 標準函式庫（3.9+），可單獨複製到其他電腦使用。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path, PurePosixPath

TIMEOUT_MS = int(os.environ.get("GIT_TIMEOUT_MS") or 10_000)


def fail(message: str) -> None:
    print(f"[report-worktrees] {message}", file=sys.stderr)
    sys.exit(1)


def git(args: list[str]) -> str:
    """以參數陣列執行 git（不經 shell）、有逾時。"""
    try:
        r = subprocess.run(
            ["git", *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=TIMEOUT_MS / 1000,
        )
    except FileNotFoundError:
        raise RuntimeError("找不到 git 執行檔") from None
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"git 執行逾時（{TIMEOUT_MS}ms）") from None
    if r.returncode != 0:
        first = (r.stderr or "").strip().split("\n")[0]
        raise RuntimeError(first or "git 執行失敗")
    return r.stdout


def normalize_path(p: str) -> str:
    n = str(PurePosixPath(p.strip().replace("\\", "/")))
    if len(n) > 1 and n.endswith("/") and not re.match(r"^[a-zA-Z]:/$", n):
        n = n[:-1]
    return n


def parse_porcelain(text: str) -> list[dict]:
    """解析 `git worktree list --porcelain`（區塊以空行分隔）。"""
    entries: list[dict] = []
    cur: dict | None = None
    for raw in re.split(r"\r?\n", text):
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
            cur = {"path": normalize_path(value), "head": None, "branch": None, "bare": False, "prunable": False}
        elif cur is not None:
            if key == "HEAD":
                cur["head"] = value or None
            elif key == "branch":
                cur["branch"] = re.sub(r"^refs/heads/", "", value) or None
            elif key == "bare":
                cur["bare"] = True
            elif key == "prunable":
                cur["prunable"] = True
    if cur:
        entries.append(cur)
    return entries


def base_branch(repo: str) -> str | None:
    for name in ("main", "master"):
        try:
            git(["-C", repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{name}"])
            return name
        except RuntimeError:
            continue
    return None


def has_own_history(repo: str, branch: str) -> bool:
    """分支是否曾有自己的變動（區分「已併入 main」與「剛建立尚未提交」，兩者 ahead 皆為 0）。"""
    try:
        out = git(["-C", repo, "reflog", "show", "--format=%gs", f"refs/heads/{branch}", "--"])
        lines = [l for l in re.split(r"\r?\n", out) if l]
        return len(lines) == 0 or any(not l.startswith("branch: Created from") for l in lines)
    except RuntimeError:
        return True


def detect(repo: str) -> list[dict]:
    entries = parse_porcelain(git(["-C", repo, "worktree", "list", "--porcelain"]))
    base = base_branch(repo)
    out: list[dict] = []
    # 第一個項目為主工作目錄（或 bare repo），不列入
    for e in [x for x in entries[1:] if not x["bare"]]:
        head = e["head"] if e["head"] and re.match(r"^[0-9a-f]{7,64}$", e["head"]) else None
        is_prunable = e["prunable"] or not os.path.exists(e["path"])
        w = {
            "path": e["path"],
            "branch": e["branch"],
            "headSha": head,
            "isDirty": False,
            "ahead": None,
            "behind": None,
            "lastCommitAt": None,
            "isPrunable": is_prunable,
            "isMerged": False,
        }
        out.append(w)
        if not head:
            continue
        if not is_prunable:
            w["isDirty"] = git(["-C", e["path"], "status", "--porcelain"]).strip() != ""
        try:
            ct = int(git(["-C", repo, "log", "-1", "--format=%ct", head]).strip())
        except ValueError:
            ct = 0
        w["lastCommitAt"] = ct * 1000 if ct > 0 else None
        if base:
            parts = git(["-C", repo, "rev-list", "--left-right", "--count", f"refs/heads/{base}...{head}"]).split()
            if len(parts) == 2 and all(p.isdigit() for p in parts):
                behind, ahead = int(parts[0]), int(parts[1])
                w["ahead"], w["behind"] = ahead, behind
                if e["branch"] and e["branch"] != base:
                    w["isMerged"] = ahead == 0 and has_own_history(repo, e["branch"])
    return out


def load_machine(machine_arg: str | None) -> dict:
    """~/.tasks-sheets/machine.json：{ machineId, machineName }；不存在時建立（machineId 隨機、之後固定）。"""
    home = os.environ.get("TASKS_SHEETS_HOME") or os.path.join(os.path.expanduser("~"), ".tasks-sheets")
    file = Path(home) / "machine.json"
    try:
        data = json.loads(file.read_text(encoding="utf-8")) or {}
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    valid_id = isinstance(data.get("machineId"), str) and re.match(r"^[A-Za-z0-9_-]{8,64}$", data["machineId"])
    stored = data.get("machineName")
    name = stored.strip() if isinstance(stored, str) and stored.strip() else (machine_arg or socket.gethostname())
    if not valid_id:
        data = {"machineId": str(uuid.uuid4()), "machineName": name}
        try:
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"[report-worktrees] 已建立電腦識別設定 {file}（可編輯 machineName 改顯示名稱）")
        except OSError as err:
            fail(f"無法建立電腦識別設定 {file}：{err}")
    return {"machineId": data["machineId"], "machineName": name}


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="python scripts/report_worktrees.py",
        description="把本機 repo 的 worktree 狀態回報給 EasyTasksSheet 伺服器",
    )
    ap.add_argument("--server", help="server 網址，例如 https://tasks.example.com")
    ap.add_argument("--path", default=".", help="repo 路徑（預設目前目錄）")
    ap.add_argument("--machine", help="電腦名稱（預設 machine.json 的 machineName 或主機名）")
    ap.add_argument("--repo", help="repo 名稱（預設取 git 頂層資料夾名）")
    ap.add_argument("--dry-run", action="store_true", help="只印出要送的內容，不連線")
    a = ap.parse_args()

    repo_path = os.path.abspath(a.path)
    if not os.path.exists(repo_path):
        fail(f"找不到 repo 路徑：{repo_path}")
    try:
        repo_name = a.repo or os.path.basename(git(["-C", repo_path, "rev-parse", "--show-toplevel"]).strip())
        worktrees = detect(repo_path)
    except RuntimeError as err:
        fail(f"讀取 worktree 失敗：{err}")
        return 1

    machine = load_machine(a.machine)
    body = {
        "machine": (a.machine or machine["machineName"])[:100],
        "machineId": machine["machineId"],
        "repo": repo_name,
        "worktrees": worktrees,
    }
    if a.dry_run:
        print(json.dumps(body, ensure_ascii=False, indent=2))
        return 0

    if not a.server:
        fail("請以 --server 指定 server 網址")
    token = os.environ.get("WORKTREE_REPORT_TOKEN")
    if not token:
        fail("請設定環境變數 WORKTREE_REPORT_TOKEN")
    server = a.server.rstrip("/")
    req = urllib.request.Request(
        f"{server}/api/eng/worktrees/report",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Report-Token": token},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            status, text = res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", "replace")
        try:
            message = json.loads(text).get("error", {}).get("message", text)
        except ValueError:
            message = text
        fail(f"回報失敗（HTTP {err.code}）：{message}")
        return 1
    except (urllib.error.URLError, OSError) as err:
        fail(f"無法連線 server：{err}")
        return 1
    data = json.loads(text)
    if data.get("held"):
        print(
            f"[report-worktrees] 注意：{data.get('message') or '這次回報被伺服器攔下，舊資料已保留'}"
            f"（這次 {data.get('count')} 筆，先前 {data.get('previous')} 筆）",
            file=sys.stderr,
        )
        return 0
    print(f"[report-worktrees] 已回報 {data.get('count')} 個 worktree（電腦 {data.get('machine')}，repo {data.get('repo') or '—'}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
