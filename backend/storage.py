"""Camada de persistência para ler e salvar arquivos JSON.

O foco aqui é simples: guardar os dados sem quebrar o arquivo, manter backup e
 deixar o JSON legível para edição manual.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Pastas do projeto
# ---------------------------------------------------------------------------
# Este arquivo fica em <raiz>/backend/, então a raiz do projeto é o pai dele.
BASE_DIR: Path = Path(__file__).resolve().parent.parent
CONFIG_DIR: Path = BASE_DIR / "config"
BACKUP_DIR: Path = CONFIG_DIR / "backups"

# Lock simples para evitar que dois saves aconteçam ao mesmo tempo.
_LOCK = threading.RLock()


def ensure_dirs() -> None:
    """Cria as pastas de config e backup quando ainda não existem."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)


def config_path(name: str) -> Path:
    """Retorna o caminho completo de um arquivo dentro da pasta config/."""
    return CONFIG_DIR / name


def load_json(path: str | Path, default: Any = None) -> Any:
    """Lê um JSON. Se não existir ou estiver quebrado, retorna o valor padrão."""
    p = Path(path)
    if not p.exists():
        return default
    try:
        with p.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        # Tenta recuperar do backup antes de devolver o valor padrão.
        bak = p.with_suffix(p.suffix + ".bak")
        if bak.exists():
            try:
                with bak.open("r", encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, OSError):
                pass
        return default


def save_json(path: str | Path, data: Any, backup: bool = True) -> None:
    """Salva um JSON no disco sem quebrar o arquivo e mantendo backup do anterior."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)

    with _LOCK:
        # Guarda a versão atual antes de escrever a nova.
        if backup and p.exists():
            try:
                shutil.copy2(p, p.with_suffix(p.suffix + ".bak"))
            except OSError:
                pass  # backup é opcional; não deve impedir o save

        # Escreve em um arquivo temporário e só então troca pelo original.
        tmp = p.with_suffix(p.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())

        try:
            os.replace(tmp, p)
        except OSError as e:
            # Defensivo: o .tmp nasce na MESMA pasta do destino, então em regra
            # não há troca entre dispositivos. Mas se algum setup exótico
            # (symlink/bind-mount atravessando filesystems) causar EXDEV,
            # caímos para shutil.move (copia + remove), que funciona sempre.
            import errno
            if e.errno == errno.EXDEV:
                shutil.move(str(tmp), str(p))
            else:
                raise
