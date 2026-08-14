"""Gerenciador de configurações gerais do aplicativo (config.json)."""

from __future__ import annotations

from typing import Any

from . import storage

CONFIG_FILE = "config.json"

# A versão do app NÃO fica aqui: a fonte única é backend/__init__.__version__.
DEFAULT_CONFIG: dict[str, Any] = {
    "app_name": "TallyUp",
    "host": "127.0.0.1",
    "port": 3210,
    "auto_open_browser": True,
    "active_profile": "default",
    "backup": True,
    "first_run": True,
}


class ConfigManager:
    """Lê/escreve config.json e expõe valores com padrões seguros."""

    def __init__(self) -> None:
        storage.ensure_dirs()
        self._path = storage.config_path(CONFIG_FILE)
        self.data: dict[str, Any] = {}
        self.load()

    # ------------------------------------------------------------------ IO
    def load(self) -> dict[str, Any]:
        loaded = storage.load_json(self._path, default=None)
        if not isinstance(loaded, dict):
            # Primeira execução: cria o arquivo com os padrões.
            self.data = dict(DEFAULT_CONFIG)
            self.save()
        else:
            # Completa chaves ausentes sem sobrescrever o que o usuário definiu.
            merged = dict(DEFAULT_CONFIG)
            merged.update(loaded)
            # Migração: "version" morava aqui; hoje vive só em backend/__init__.
            if merged.pop("version", None) is not None:
                self.data = merged
                self.save()
            self.data = merged
        return self.data

    def save(self) -> None:
        storage.save_json(self._path, self.data, backup=self.data.get("backup", True))

    # --------------------------------------------------------------- acesso
    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self.data[key] = value
        self.save()

    def update(self, values: dict[str, Any]) -> dict[str, Any]:
        self.data.update(values)
        self.save()
        return self.data

    # ---------------------------------------------------------------- extras
    @property
    def host(self) -> str:
        return str(self.data.get("host", "127.0.0.1"))

    @property
    def port(self) -> int:
        return int(self.data.get("port", 3210))
