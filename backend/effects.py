"""Efeitos (VFX) — animações de mudança de valor (Fase 5).

Biblioteca GLOBAL de presets em config/effects.json (compartilhada entre
perfis; cada perfil escolhe qual usar no tema, e cada elemento pode ter o seu
no style). Cada efeito tem::

    { "id": "pop", "name": "Pop", "builtin": true, "css": "..." }

Convenção do CSS: quando o valor de um elemento muda, a classe ``fx-<id>`` é
aplicada ao elemento (.counter) no overlay — o CSS do efeito anima a partir
dela. Variáveis do tema (--accent, --text-shadow etc.) estão disponíveis.
"""

from __future__ import annotations

from typing import Any, Optional

from . import storage
from .profiles import slugify

EFFECTS_FILE = "effects.json"
MAX_CSS = 20_000  # limite de tamanho por efeito

DEFAULTS: list[dict[str, Any]] = [
    {"id": "pop", "name": "Pop", "builtin": True, "css":
        ".fx-pop .value { animation: fx-pop .35s ease; }\n"
        "@keyframes fx-pop {\n"
        "  0%   { transform: scale(1); }\n"
        "  30%  { transform: scale(1.28); color: var(--accent); }\n"
        "  100% { transform: scale(1); }\n"
        "}"},
    {"id": "flash", "name": "Flash", "builtin": True, "css":
        ".fx-flash { animation: fx-flash .45s ease; }\n"
        "@keyframes fx-flash {\n"
        "  0%   { filter: brightness(2.4); }\n"
        "  100% { filter: brightness(1); }\n"
        "}"},
    {"id": "shake", "name": "Tremer", "builtin": True, "css":
        ".fx-shake { animation: fx-shake .4s ease; }\n"
        "@keyframes fx-shake {\n"
        "  0%, 100% { transform: translateX(0); }\n"
        "  20% { transform: translateX(-8px); }\n"
        "  40% { transform: translateX(8px); }\n"
        "  60% { transform: translateX(-5px); }\n"
        "  80% { transform: translateX(5px); }\n"
        "}"},
    {"id": "bounce", "name": "Quicar", "builtin": True, "css":
        ".fx-bounce { animation: fx-bounce .5s cubic-bezier(.28,.84,.42,1); }\n"
        "@keyframes fx-bounce {\n"
        "  0%   { transform: translateY(0); }\n"
        "  30%  { transform: translateY(-18px); }\n"
        "  55%  { transform: translateY(0); }\n"
        "  70%  { transform: translateY(-7px); }\n"
        "  100% { transform: translateY(0); }\n"
        "}"},
    {"id": "zoom", "name": "Zoom", "builtin": True, "css":
        ".fx-zoom .value { animation: fx-zoom .4s ease-out; }\n"
        "@keyframes fx-zoom {\n"
        "  0%   { transform: scale(2.2); opacity: 0; }\n"
        "  100% { transform: scale(1); opacity: 1; }\n"
        "}"},
    {"id": "slide", "name": "Deslizar", "builtin": True, "css":
        ".fx-slide .value { animation: fx-slide .35s ease-out; }\n"
        "@keyframes fx-slide {\n"
        "  0%   { transform: translateY(.6em); opacity: 0; }\n"
        "  100% { transform: translateY(0); opacity: 1; }\n"
        "}"},
    {"id": "glow", "name": "Brilho", "builtin": True, "css":
        ".fx-glow .value { animation: fx-glow .8s ease; }\n"
        "@keyframes fx-glow {\n"
        "  0%, 100% { text-shadow: var(--text-shadow); }\n"
        "  40% { text-shadow: 0 0 18px var(--accent), 0 0 6px var(--accent); }\n"
        "}"},
    {"id": "rainbow", "name": "Arco-íris", "builtin": True, "css":
        ".fx-rainbow { animation: fx-rainbow .8s linear; }\n"
        "@keyframes fx-rainbow {\n"
        "  0%   { filter: hue-rotate(0deg); }\n"
        "  100% { filter: hue-rotate(360deg); }\n"
        "}"},
]

_BUILTIN_IDS = {e["id"] for e in DEFAULTS}


def _sanitize(e: Any) -> Optional[dict[str, Any]]:
    if not isinstance(e, dict):
        return None
    eid = slugify(str(e.get("id", "")))
    name = str(e.get("name", "")).strip()
    css = str(e.get("css", ""))
    if not eid or not name or not css:
        return None
    return {"id": eid, "name": name[:60], "builtin": eid in _BUILTIN_IDS, "css": css[:MAX_CSS]}


class EffectsManager:
    def __init__(self) -> None:
        storage.ensure_dirs()
        self._path = storage.config_path(EFFECTS_FILE)
        self.effects: list[dict[str, Any]] = []
        self.load()

    # ------------------------------------------------------------------- IO
    def load(self) -> list[dict[str, Any]]:
        data = storage.load_json(self._path, default=None)
        raw = data.get("effects") if isinstance(data, dict) else None
        if not isinstance(raw, list):
            self.effects = [dict(e) for e in DEFAULTS]
            self.save()
        else:
            self.effects = [s for s in (_sanitize(e) for e in raw) if s]
            if not self.effects:
                self.effects = [dict(e) for e in DEFAULTS]
                self.save()
        return self.effects

    def save(self) -> None:
        storage.save_json(self._path, {"effects": self.effects}, backup=True)

    # --------------------------------------------------------------- leitura
    def list(self) -> list[dict[str, Any]]:
        return self.effects

    def get(self, effect_id: str) -> Optional[dict[str, Any]]:
        return next((e for e in self.effects if e["id"] == effect_id), None)

    # ----------------------------------------------------------------- ações
    def upsert(self, name: str, css: str, effect_id: Optional[str] = None) -> dict[str, Any]:
        """Cria (id None -> slug do nome) ou atualiza um efeito."""
        name = str(name or "").strip()
        css = str(css or "")
        if not name:
            raise ValueError("Dê um nome ao efeito.")
        if not css.strip():
            raise ValueError("O CSS do efeito está vazio.")
        if len(css) > MAX_CSS:
            raise ValueError(f"CSS muito grande (máximo {MAX_CSS // 1000} KB).")
        eid = slugify(effect_id or name)
        if not eid:
            raise ValueError("Nome de efeito inválido.")
        entry = {"id": eid, "name": name[:60], "builtin": eid in _BUILTIN_IDS, "css": css}
        existing = self.get(eid)
        if existing:
            existing.update(entry)
        else:
            self.effects.append(entry)
        self.save()
        return entry

    def delete(self, effect_id: str) -> bool:
        e = self.get(effect_id)
        if not e:
            return False
        self.effects.remove(e)
        self.save()
        return True

    def reset(self) -> list[dict[str, Any]]:
        """Restaura os efeitos padrão (mantém os efeitos criados pelo usuário)."""
        customs = [e for e in self.effects if e["id"] not in _BUILTIN_IDS]
        self.effects = [dict(e) for e in DEFAULTS] + customs
        self.save()
        return self.effects
