"""第一次使用：建 .venv、裝套件、建資料夾、複製 .env 範本。只需要 Python 3.11+。

    python scripts/install.py            建立 .venv 並安裝 requirements.txt
    python scripts/install.py --dev      另外安裝測試用套件（pytest-playwright；瀏覽器要再跑 playwright install chromium）
    python scripts/install.py --check    只檢查，不安裝

裝完後啟動：Windows  .venv\\Scripts\\python main.py ／ 其他  .venv/bin/python main.py
重複執行是安全的（已存在的東西不會重做、不會覆蓋 .env）。
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENV = ROOT / ".venv"
IS_WIN = sys.platform == "win32"
VENV_PY = VENV / ("Scripts/python.exe" if IS_WIN else "bin/python")
CHECK_MODULES = ("fastapi", "uvicorn", "pydantic", "argon2", "dotenv", "multipart")


def run(*cmd: str) -> None:
    print("  $", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, cwd=ROOT)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dev", action="store_true", help="另外安裝 requirements-dev.txt（測試用）")
    ap.add_argument("--check", action="store_true", help="只檢查，不安裝")
    args = ap.parse_args()

    if sys.version_info < (3, 11):
        print(f"需要 Python 3.11 以上，目前是 {sys.version.split()[0]}", file=sys.stderr)
        return 1

    if not args.check:
        if not VENV_PY.exists():
            print("[1/4] 建立虛擬環境 .venv", flush=True)
            run(sys.executable, "-m", "venv", str(VENV))
        else:
            print("[1/4] .venv 已存在", flush=True)
        print("[2/4] 安裝套件", flush=True)
        run(str(VENV_PY), "-m", "pip", "install", "-q", "-r", str(ROOT / "requirements.txt"))
        if args.dev:
            run(str(VENV_PY), "-m", "pip", "install", "-q", "-r", str(ROOT / "requirements-dev.txt"))
        print("[3/4] 建立資料夾與 .env", flush=True)
        for d in ("data", "logs", "backups"):
            (ROOT / d).mkdir(exist_ok=True)
        if not (ROOT / ".env").exists():
            shutil.copy(ROOT / ".env.example", ROOT / ".env")
            print("  已從 .env.example 複製出 .env（請視需要修改 HOST / PORT / BASE_PATH）", flush=True)
    else:
        if not VENV_PY.exists():
            print(f"找不到 {VENV_PY}；請先執行 python scripts/install.py", file=sys.stderr)
            return 1

    print("[4/4] 檢查關鍵套件", flush=True)
    code = "import importlib,sys\nmissing=[m for m in sys.argv[1:] if importlib.util.find_spec(m) is None]\nprint(' '.join(missing))"
    out = subprocess.run([str(VENV_PY), "-c", code, *CHECK_MODULES], capture_output=True, text=True, cwd=ROOT)
    missing = out.stdout.split()
    if missing:
        print(f"  缺少：{', '.join(missing)}", file=sys.stderr)
        return 1
    print("  全部就緒。", flush=True)
    py = ".venv\\Scripts\\python" if IS_WIN else ".venv/bin/python"
    print(f"\n啟動：{py} main.py\n", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
