"""Presets de tema do usuário (Fase 3).

Biblioteca GLOBAL em config/theme_presets.json (compartilhada entre perfis),
no mesmo espírito do EffectsManager. Cada preset tem::

    { "id": "meu-tema", "name": "Meu tema", "theme": { ...chaves do tema... } }

Ao salvar, as chaves que pertencem ao PERFIL (e não à aparência) são
removidas — canvas, contadores de win rate e nome do tema — para que aplicar
um preset em outro perfil não bagunce essas configurações.
"""

from __future__ import annotations

from typing import Any, Optional

from . import storage
from .profiles import slugify

PRESETS_FILE = "theme_presets.json"
MAX_PRESETS = 100

# Chaves do tema que NÃO entram no preset (são do perfil, não da aparência).
PROFILE_ONLY_KEYS = {"name", "canvas_width", "canvas_height", "winrate_w", "winrate_l"}


def strip_profile_keys(theme: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in (theme or {}).items() if k not in PROFILE_ONLY_KEYS}


def _sanitize(p: Any) -> Optional[dict[str, Any]]:
    if not isinstance(p, dict):
        return None
    pid = slugify(str(p.get("id", "")))
    name = str(p.get("name", "")).strip()
    theme = p.get("theme")
    if not pid or not name or not isinstance(theme, dict):
        return None
    return {"id": pid, "name": name[:60], "theme": strip_profile_keys(theme)}


class ThemePresetsManager:
    def __init__(self) -> None:
        storage.ensure_dirs()
        self._path = storage.config_path(PRESETS_FILE)
        self.presets: list[dict[str, Any]] = []
        self.load()

    # ------------------------------------------------------------------- IO
    def load(self) -> list[dict[str, Any]]:
        data = storage.load_json(self._path, default=None)
        raw = data.get("presets") if isinstance(data, dict) else None
        self.presets = [s for s in (_sanitize(p) for p in (raw or [])) if s]
        return self.presets

    def save(self) -> None:
        storage.save_json(self._path, {"presets": self.presets}, backup=True)

    # --------------------------------------------------------------- leitura
    def list(self) -> list[dict[str, Any]]:
        return self.presets

    def get(self, preset_id: str) -> Optional[dict[str, Any]]:
        return next((p for p in self.presets if p["id"] == preset_id), None)

    # ----------------------------------------------------------------- ações
    def upsert(self, name: str, theme: dict[str, Any],
               preset_id: Optional[str] = None) -> dict[str, Any]:
        """Cria (id None -> slug do nome) ou atualiza um preset com o tema dado."""
        name = str(name or "").strip()
        if not name:
            raise ValueError("Dê um nome ao preset.")
        if not isinstance(theme, dict) or not theme:
            raise ValueError("Tema vazio — nada para salvar.")
        pid = slugify(preset_id or name)
        if not pid:
            raise ValueError("Nome de preset inválido.")
        entry = {"id": pid, "name": name[:60], "theme": strip_profile_keys(theme)}
        existing = self.get(pid)
        if existing:
            existing.update(entry)
        elif len(self.presets) >= MAX_PRESETS:
            raise ValueError(f"Limite de {MAX_PRESETS} presets atingido.")
        else:
            self.presets.append(entry)
        self.save()
        return entry

    def delete(self, preset_id: str) -> bool:
        p = self.get(preset_id)
        if not p:
            return False
        self.presets.remove(p)
        self.save()
        return True
