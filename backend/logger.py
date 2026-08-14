from __future__ import annotations

from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG_PATH = ROOT / "hotkeys.log"


def init_log() -> None:
    try:
        with LOG_PATH.open("w", encoding="utf-8") as handle:
            handle.write(f"=== hotkeys session started: {datetime.now().isoformat()} ===\n")
    except Exception:
        pass


def log(message: str, *args) -> None:
    try:
        text = message.format(*args)
        now = datetime.now().isoformat()
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(f"{now} {text}\n")
    except Exception:
        pass
