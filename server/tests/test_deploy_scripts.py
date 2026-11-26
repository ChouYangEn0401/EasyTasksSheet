"""deploy/windows 的 .bat / .ps1 靜態檢查（沒有 Windows 也能在 CI 抓到會讓 cmd.exe 壞掉的寫法）。

為什麼要有：
- cmd.exe 讀 UTF-8 批次檔時，call / goto 之後會跳到錯誤的位元組位置，從某行中間開始執行
  （152 上實際發生過：「的解析 was unexpected at this time.」）→ 批次檔一律純 ASCII。
- 換行必須是 CRLF：LF 時 goto / call 有時找不到標籤。
- 括號區塊內，任何沒有引號、沒有 ^ 跳脫的 ")" 都會提早結束區塊（例如 echo 文字裡的 "(x86)"）。
- goto / call 的標籤必須存在。
- Windows PowerShell 5.1 讀沒有 BOM 的 UTF-8 .ps1 會亂碼 → .ps1 也一律純 ASCII。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

DEPLOY_DIR = Path(__file__).resolve().parents[2] / "deploy" / "windows"
BAT_FILES = sorted(DEPLOY_DIR.glob("*.bat"))
PS1_FILES = sorted(DEPLOY_DIR.glob("*.ps1"))

_LABEL_RE = re.compile(r"^\s*:([A-Za-z0-9_]+)\s*$")
_JUMP_RE = re.compile(r"\b(?:goto|call)\s+:?([A-Za-z0-9_]+)", re.IGNORECASE)
_BLOCK_OPENERS = {"if", "for", "else", "do"}


def _logical_lines(text: str) -> list[tuple[int, str]]:
    out = []
    for no, line in enumerate(text.replace("\r\n", "\n").split("\n"), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("::") or re.match(r"(?i)^@?rem(\s|$)", stripped):
            continue
        if _LABEL_RE.match(line):
            continue
        out.append((no, line))
    return out


def check_blocks(text: str) -> list[str]:
    """近似 cmd.exe 的括號區塊解析，回傳錯誤訊息（空 = 沒問題）。

    - "(" 只有在「指令開頭」或 if / for / else / do 這類指令後才開新區塊；
      echo 等一般文字裡的 "(" 不算。
    - 區塊內（depth > 0）任何沒被引號包住、沒有 ^ 跳脫的 ")" 都會關閉區塊；
      關閉後同一行只能接 else、do（for 的集合）、&、|、> 或另一個 ")"，否則就是「提早關閉」。
    """
    errors: list[str] = []
    depth = 0
    for no, line in _logical_lines(text):
        in_quote = False
        first_word: str | None = None  # 目前這個指令的第一個字
        word = ""
        i = 0
        while i < len(line):
            ch = line[i]
            if ch == "^" and not in_quote:
                i += 2
                continue
            if ch == '"':
                in_quote = not in_quote
            elif not in_quote and ch == "(":
                if first_word is None or first_word.lower().lstrip("@") in _BLOCK_OPENERS:
                    depth += 1
                    first_word = None
                    word = ""
                    i += 1
                    continue
            elif not in_quote and ch == ")" and depth > 0:
                depth -= 1
                rest = line[i + 1 :].lstrip()
                if rest and not re.match(r"(?i)(else\b|do\b|&|\||>|2>|\))", rest):
                    errors.append(f"第 {no} 行：區塊被 ')' 提早關閉，後面還有「{rest[:30]}」（echo 文字裡的括號要用 ^) 跳脫）")
                first_word = None
                word = ""
                i += 1
                continue
            elif not in_quote and ch == "&":
                first_word = None
                word = ""
                i += 1
                continue
            if not in_quote and ch.isspace():
                if word and first_word is None:
                    first_word = word
                    if word.lower() == "else":
                        first_word = "else"
                word = ""
            elif not in_quote:
                word += ch
            i += 1
        if word and first_word is None:
            first_word = word
        if in_quote:
            errors.append(f"第 {no} 行：引號沒有成對")
        if depth < 0:
            errors.append(f"第 {no} 行：')' 比 '(' 多")
            depth = 0
    if depth != 0:
        errors.append(f"檔案結束時還有 {depth} 個括號區塊沒有關閉")
    return errors


def check_labels(text: str) -> list[str]:
    labels = {m.group(1).lower() for line in text.replace("\r\n", "\n").split("\n") if (m := _LABEL_RE.match(line))}
    errors = []
    for no, line in _logical_lines(text):
        for m in _JUMP_RE.finditer(line):
            target = m.group(1).lower()
            # call 外部程式（call npm ...）不是標籤
            if m.group(0).lower().startswith("call") and ":" not in m.group(0):
                continue
            if target == "eof":
                continue
            if target not in labels:
                errors.append(f"第 {no} 行：找不到標籤 :{target}")
    return errors


def test_found_scripts():
    assert BAT_FILES, f"{DEPLOY_DIR} 裡沒有 .bat"


@pytest.mark.parametrize("path", BAT_FILES + PS1_FILES, ids=lambda p: p.name)
def test_ascii_only(path: Path):
    data = path.read_bytes()
    bad = [i for i, b in enumerate(data) if b > 0x7F]
    assert not bad, f"{path.name} 含非 ASCII 字元（第一個在 byte {bad[0]}）。cmd / PowerShell 5.1 會讀錯，請改用英文"


@pytest.mark.parametrize("path", BAT_FILES + PS1_FILES, ids=lambda p: p.name)
def test_crlf_line_endings(path: Path):
    data = path.read_bytes()
    lone_lf = data.count(b"\n") - data.count(b"\r\n")
    assert lone_lf == 0, f"{path.name} 有 {lone_lf} 個只有 LF 的換行，必須是 CRLF"


@pytest.mark.parametrize("path", BAT_FILES, ids=lambda p: p.name)
def test_bat_blocks_balanced(path: Path):
    assert check_blocks(path.read_bytes().decode("ascii")) == []


@pytest.mark.parametrize("path", BAT_FILES, ids=lambda p: p.name)
def test_bat_labels_exist(path: Path):
    assert check_labels(path.read_bytes().decode("ascii")) == []


# ── 檢查器本身：確認真的抓得到錯 ──────────────────────────────────────


def _bat(*lines: str) -> str:
    return "\r\n".join(lines) + "\r\n"


def test_checker_catches_early_close_from_echo_text():
    bad = _bat("if exist x (", "  echo see C:\\Program Files (x86) folder", ")")
    assert any("提早關閉" in e for e in check_blocks(bad))


def test_checker_accepts_escaped_and_quoted_parens():
    ok = _bat("if exist x (", "  echo see ^(x86^) here", '  echo "a (b) c"', ") else (", "  echo no", ")")
    assert check_blocks(ok) == []


def test_checker_accepts_one_line_if_else():
    ok = _bat("if errorlevel 1 (echo bad) else (echo good)", "if defined A if !A! GEQ 22 (", "  echo x", ")")
    assert check_blocks(ok) == []


def test_checker_accepts_for_loops():
    ok = _bat('for %%I in ("%~dp0..\\..") do set "X=%%~fI"', "for /f %%S in ('ps -c \"(a).b\"') do (", "  echo %%S", ")")
    assert check_blocks(ok) == []


def test_checker_catches_unclosed_block():
    assert check_blocks(_bat("if exist x (", "  echo hi")) != []


def test_checker_catches_missing_label():
    assert check_labels(_bat("call :nope", "goto :end", ":end")) == ["第 1 行：找不到標籤 :nope"]
    assert check_labels(_bat("call npm ci", "goto :eof")) == []
