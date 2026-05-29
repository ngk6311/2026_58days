from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT / ".env"
ENV_EXAMPLE_PATH = ROOT / ".env.example"


def read_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}

    result: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        result[key.strip()] = value.replace("\\n", "\n")

    return result


def write_env_file(values: dict[str, str]) -> None:
    lines: list[str] = []
    for key, value in values.items():
        safe_value = value.replace("\n", "\\n")
        if " " in safe_value or safe_value.startswith('"') or safe_value.endswith('"'):
            safe_value = f'"{safe_value}"'
        lines.append(f"{key}={safe_value}")
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def find_executable(name: str) -> str | None:
    candidates = [name]
    if sys.platform.startswith("win") and not name.lower().endswith(".cmd"):
        candidates.insert(0, f"{name}.cmd")
        candidates.insert(1, f"{name}.exe")

    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    return None


def ensure_node_tools() -> tuple[str, str]:
    node_path = find_executable("node")
    npm_path = find_executable("npm")
    if not node_path or not npm_path:
        raise SystemExit("找不到 node 或 npm。請先安裝 Node.js，然後重新開啟終端機。")
    return node_path, npm_path


def run_command(command: list[str]) -> None:
    subprocess.run(command, cwd=ROOT, check=True)


def ensure_dependencies() -> tuple[str, str]:
    node_path, npm_path = ensure_node_tools()
    if (ROOT / "node_modules").exists():
        return node_path, npm_path

    print("第一次執行，正在安裝必要套件...")
    run_command([npm_path, "install"])
    return node_path, npm_path


def playwright_browser_ready() -> bool:
    cache_root = Path.home() / "AppData" / "Local" / "ms-playwright"
    if not cache_root.exists():
        return False
    return any(cache_root.glob("chromium-*/chrome-win64/chrome.exe"))


def ensure_playwright_browser(npm_path: str) -> None:
    if playwright_browser_ready():
        return
    print("第一次需要下載 Playwright 的 Chromium 瀏覽器...")
    run_command([npm_path, "exec", "playwright", "install", "chromium"])


def prompt(label: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{label}{suffix}: ").strip()
    return value or default


def cmd_init() -> None:
    current = read_env_file(ENV_PATH)
    defaults = read_env_file(ENV_EXAMPLE_PATH)

    values = {
        "FORTUNE_PARTNERS_URL": current.get(
            "FORTUNE_PARTNERS_URL",
            defaults.get(
                "FORTUNE_PARTNERS_URL",
                "https://www.bigsmileunity.com/bigsmile/fortune-game/partners",
            ),
        ),
        "FORTUNE_SHEET_ID": current.get(
            "FORTUNE_SHEET_ID",
            defaults.get("FORTUNE_SHEET_ID", ""),
        ),
        "FORTUNE_TIMEZONE": current.get(
            "FORTUNE_TIMEZONE",
            defaults.get("FORTUNE_TIMEZONE", "Asia/Taipei"),
        ),
        "FORTUNE_SCORE_RESET_HOUR": current.get(
            "FORTUNE_SCORE_RESET_HOUR",
            defaults.get("FORTUNE_SCORE_RESET_HOUR", "0"),
        ),
        "FORTUNE_WEEK_START": current.get(
            "FORTUNE_WEEK_START",
            defaults.get("FORTUNE_WEEK_START", "1"),
        ),
        "FORTUNE_LOG_LIMIT": current.get(
            "FORTUNE_LOG_LIMIT",
            defaults.get("FORTUNE_LOG_LIMIT", "100"),
        ),
        "FORTUNE_LOOKBACK_DAYS": current.get(
            "FORTUNE_LOOKBACK_DAYS",
            defaults.get("FORTUNE_LOOKBACK_DAYS", "28"),
        ),
        "GOOGLE_CREDENTIALS_PATH": current.get(
            "GOOGLE_CREDENTIALS_PATH",
            defaults.get("GOOGLE_CREDENTIALS_PATH", "./credentials.json"),
        ),
    }

    print("請輸入設定，直接按 Enter 可保留預設值。")
    for key in list(values.keys()):
        values[key] = prompt(key, values[key])

    write_env_file(values)
    print(f"已產生設定檔：{ENV_PATH}")
    print("接著請把 Google service account JSON 放到 credentials.json，或填你指定的路徑。")


def cmd_auth() -> None:
    _, npm_path = ensure_dependencies()
    ensure_playwright_browser(npm_path)
    run_command([npm_path, "run", "auth"])


def cmd_sync() -> None:
    _, npm_path = ensure_dependencies()
    if not ENV_PATH.exists():
        raise SystemExit("找不到 .env，請先執行：python run.py init")
    run_command([npm_path, "run", "sync"])


def cmd_all() -> None:
    if not ENV_PATH.exists():
        cmd_init()
    cmd_auth()
    cmd_sync()


def main() -> None:
    parser = argparse.ArgumentParser(description="Fortune Game -> Google Sheet 同步工具")
    parser.add_argument(
        "command",
        choices=["init", "auth", "sync", "all"],
        help="init: 產生設定, auth: 登入授權, sync: 同步資料, all: 全部跑一次",
    )
    args = parser.parse_args()

    if args.command == "init":
        cmd_init()
    elif args.command == "auth":
        cmd_auth()
    elif args.command == "sync":
        cmd_sync()
    else:
        cmd_all()


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        print(f"執行失敗: {' '.join(exc.cmd)}")
        sys.exit(exc.returncode)
