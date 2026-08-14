"""Backup automático (Fase 2) — snapshots zip de config/ em config/backups/.

Complementa o `.bak` rolling do storage: aqui é um snapshot COMPLETO
(contadores, tema, hotkeys e todos os perfis), gerado no startup e depois em
intervalo fixo. Mantém apenas os N mais recentes.
"""

from __future__ import annotations

import threading
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Optional

from . import logger, storage

KEEP = 10
INTERVAL_S = 30 * 60  # 30 minutos


def make_snapshot() -> Optional[Path]:
    """Gera config/backups/backup-AAAAmmdd-HHMMSS.zip com todos os .json."""
    try:
        storage.ensure_dirs()
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        dest = storage.BACKUP_DIR / f"backup-{stamp}.zip"
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(storage.CONFIG_DIR.rglob("*.json")):
                if storage.BACKUP_DIR in f.parents:
                    continue
                z.write(f, f.relative_to(storage.CONFIG_DIR))
        _prune()
        return dest
    except Exception as e:  # backup nunca deve derrubar o servidor
        logger.log("backup failed: {}", e)
        return None


def _prune(keep: int = KEEP) -> None:
    snaps = sorted(storage.BACKUP_DIR.glob("backup-*.zip"))
    for old in snaps[:-keep]:
        try:
            old.unlink()
        except OSError as e:
            # Não derruba o backup, mas deixa rastro: se houver problema de
            # permissão persistente, a pasta cresceria para sempre em silêncio.
            logger.log("backup: falha ao apagar snapshot antigo {}: {}", old.name, e)


class BackupScheduler:
    """Roda make_snapshot no startup e a cada INTERVAL_S, em thread daemon."""

    def __init__(self, interval_s: int = INTERVAL_S) -> None:
        self.interval = interval_s
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        make_snapshot()  # snapshot inicial
        while not self._stop.wait(self.interval):
            make_snapshot()

    def stop(self) -> None:
        self._stop.set()
