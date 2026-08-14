"""Fixtures dos testes.

Isolamento: cada teste roda com config/ em um diretório temporário —
os testes NUNCA tocam nos arquivos reais do projeto. Para isso, os caminhos
do storage/logger são trocados ANTES de importar o server (que cria os
managers no import).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture()
def tmp_storage(tmp_path, monkeypatch):
    """Aponta o storage (e o log) para um diretório temporário."""
    from backend import logger, storage

    monkeypatch.setattr(storage, "CONFIG_DIR", tmp_path / "config")
    monkeypatch.setattr(storage, "BACKUP_DIR", tmp_path / "config" / "backups")
    monkeypatch.setattr(logger, "LOG_PATH", tmp_path / "hotkeys.log")
    storage.ensure_dirs()
    return tmp_path


@pytest.fixture()
def server_mod(tmp_storage):
    """Importa um server 'fresco' com o storage isolado."""
    sys.modules.pop("server", None)
    import server  # noqa: F401  (import cria os managers já no tmp)

    server.config.data["auto_open_browser"] = False  # não abre navegador em teste

    # Uploads de imagem também vão para o tmp (e o mount /assets acompanha).
    assets_tmp = tmp_storage / "assets"
    assets_tmp.mkdir(parents=True, exist_ok=True)
    server.ASSETS_DIR = assets_tmp
    for route in server.app.routes:
        if getattr(route, "path", "") == "/assets":
            route.app.directory = str(assets_tmp)
            route.app.all_directories = [str(assets_tmp)]

    yield server
    sys.modules.pop("server", None)


@pytest.fixture()
def client(server_mod):
    """TestClient com lifespan (startup/shutdown) ativo."""
    from fastapi.testclient import TestClient

    with TestClient(server_mod.app) as c:
        c.server = server_mod
        yield c
