"""Perfis — múltiplos conjuntos de contadores, tema e hotkeys (Fase 2).

Cada perfil (ex.: "dark-souls", "valorant", "speedrun") guarda seus próprios
arquivos. O perfil "default" usa os arquivos diretamente em config/ (compatível
com a Fase 1); os demais ficam em subpastas::

    config/                       <- perfil "default"
        counters.json
        theme.json
        hotkeys.json
        profiles/
            dark-souls/
                counters.json
                theme.json
                hotkeys.json

O perfil ativo é gravado em config.json ("active_profile"). Criar um perfil
copia os arquivos do perfil ativo como ponto de partida.
"""

from __future__ import annotations

import re
import shutil
import unicodedata
from pathlib import Path

from . import storage

DEFAULT = "default"
PROFILE_FILES = ("counters.json", "theme.json", "hotkeys.json")
_SLUG_RE = re.compile(r"[^a-z0-9-]+")

# ---------------------------------------------------------------------------
# Templates de perfis — contadores prontos + tema inspirado no jogo.
# (Os contadores omitem id/x/y: o CounterManager sanitiza e empilha por order.)
# Os mesmos temas existem como presets no editor (admin/app.js).
# ---------------------------------------------------------------------------
TEMPLATES: dict[str, dict] = {
    "overwatch": {
        "label": "Overwatch — Vitórias · Derrotas · Empates",
        "name": "Overwatch",
        "counters": [
            {"name": "Vitórias", "value": 0, "step": 1, "order": 0},
            {"name": "Derrotas", "value": 0, "step": 1, "order": 1},
            {"name": "Empates", "value": 0, "step": 1, "order": 2},
        ],
        "theme": {
            "font_family": "Inter, Segoe UI, Arial, sans-serif", "font_size": 48,
            "font_weight": "900", "italic": True, "value_color": "#ffffff",
            "label_color": "#f99e1a", "accent_color": "#f99e1a",
            "card_background": "rgba(24,30,44,0.85)", "card_border": "0px solid transparent",
            "border_radius": 6, "padding": 16, "shadow": "0 6px 18px rgba(0,0,0,0.45)",
            "text_shadow": "2px 2px 6px rgba(0,0,0,0.9)", "uppercase_labels": True,
            "letter_spacing": 1, "line_height": 1.1, "text_transform": "none",
        },
    },
    "darksouls": {
        "label": "Dark Souls — Mortes · Bosses derrotados",
        "name": "Dark Souls",
        "counters": [
            {"name": "Mortes", "value": 0, "step": 1, "order": 0},
            {"name": "Bosses derrotados", "value": 0, "step": 1, "order": 1},
        ],
        "theme": {
            "font_family": "Georgia, serif", "font_size": 46, "font_weight": "700",
            "italic": False, "value_color": "#e8d9a0", "label_color": "#a89468",
            "accent_color": "#8a1313", "card_background": "rgba(12,10,8,0.82)",
            "card_border": "1px solid #3a3226", "border_radius": 4, "padding": 16,
            "shadow": "0 8px 22px rgba(0,0,0,0.7)", "text_shadow": "2px 2px 8px rgba(0,0,0,0.95)",
            "uppercase_labels": True, "letter_spacing": 2, "line_height": 1.15,
            "text_transform": "none",
        },
    },
    "valorant": {
        "label": "Valorant — Vitórias · Derrotas · Aces",
        "name": "Valorant",
        "counters": [
            {"name": "Vitórias", "value": 0, "step": 1, "order": 0},
            {"name": "Derrotas", "value": 0, "step": 1, "order": 1},
            {"name": "Aces", "value": 0, "step": 1, "order": 2},
        ],
        "theme": {
            "font_family": "'Segoe UI', Arial, sans-serif", "font_size": 48,
            "font_weight": "800", "italic": False, "value_color": "#ffffff",
            "label_color": "#ff4655", "accent_color": "#ff4655",
            "card_background": "rgba(15,25,35,0.85)", "card_border": "2px solid #ff4655",
            "border_radius": 0, "padding": 14, "shadow": "0 4px 14px rgba(255,70,85,0.35)",
            "text_shadow": "1px 1px 3px rgba(0,0,0,0.8)", "uppercase_labels": True,
            "letter_spacing": 2, "line_height": 1.1, "text_transform": "uppercase",
        },
    },
    "league": {
        "label": "League of Legends — Vitórias · Derrotas · Pentakills",
        "name": "League of Legends",
        "counters": [
            {"name": "Vitórias", "value": 0, "step": 1, "order": 0},
            {"name": "Derrotas", "value": 0, "step": 1, "order": 1},
            {"name": "Pentakills", "value": 0, "step": 1, "order": 2},
        ],
        "theme": {
            "font_family": "Georgia, serif", "font_size": 46, "font_weight": "700",
            "italic": False, "value_color": "#f0e6d2", "label_color": "#c8aa6e",
            "accent_color": "#0ac8b9", "card_background": "rgba(1,10,19,0.85)",
            "card_border": "1px solid #c8aa6e", "border_radius": 2, "padding": 16,
            "shadow": "0 6px 18px rgba(0,0,0,0.6)", "text_shadow": "1px 1px 4px rgba(0,0,0,0.9)",
            "uppercase_labels": True, "letter_spacing": 1, "line_height": 1.1,
            "text_transform": "none",
        },
    },
    "minecraft": {
        "label": "Minecraft — Mortes · Dias sobrevividos",
        "name": "Minecraft",
        "counters": [
            {"name": "Mortes", "value": 0, "step": 1, "order": 0},
            {"name": "Dias sobrevividos", "value": 0, "step": 1, "order": 1},
        ],
        "theme": {
            "font_family": "'Courier New', monospace", "font_size": 44,
            "font_weight": "900", "italic": False, "value_color": "#ffffff",
            "label_color": "#55ff55", "accent_color": "#55ff55",
            "card_background": "rgba(28,28,28,0.85)", "card_border": "3px solid #000000",
            "border_radius": 0, "padding": 12, "shadow": "4px 4px 0 rgba(0,0,0,0.8)",
            "text_shadow": "3px 3px 0 #3f3f3f", "uppercase_labels": False,
            "letter_spacing": 1, "line_height": 1.1, "text_transform": "none",
        },
    },
    "speedrun": {
        "label": "Speedrun — Tentativas · Resets · Recordes",
        "name": "Speedrun",
        "counters": [
            {"name": "Tentativas", "value": 0, "step": 1, "order": 0},
            {"name": "Resets", "value": 0, "step": 1, "order": 1},
            {"name": "Recordes (PB)", "value": 0, "step": 1, "order": 2},
        ],
        "theme": {
            "font_family": "'Courier New', monospace", "font_size": 44,
            "font_weight": "700", "italic": False, "value_color": "#ffffff",
            "label_color": "#29ff90", "accent_color": "#29ff90",
            "card_background": "rgba(0,0,0,0.7)", "card_border": "1px solid #29ff90",
            "border_radius": 6, "padding": 12, "shadow": "0 4px 10px rgba(0,0,0,0.5)",
            "text_shadow": "1px 1px 2px #000", "uppercase_labels": True,
            "letter_spacing": 1, "line_height": 1.1, "text_transform": "uppercase",
        },
    },
}


def templates_payload() -> list[dict]:
    """Lista resumida para o painel (id, label e nome sugerido)."""
    return [{"id": k, "label": v["label"], "name": v["name"]} for k, v in TEMPLATES.items()]


def slugify(name: str) -> str:
    """Converte um nome livre em slug seguro para pasta ('Dark Souls' -> 'dark-souls')."""
    s = str(name or "").strip().lower()
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = _SLUG_RE.sub("-", s.replace(" ", "-"))
    s = re.sub(r"-{2,}", "-", s).strip("-")   # colapsa hífens repetidos
    return s[:40]


class ProfileManager:
    def __init__(self, active: str = DEFAULT) -> None:
        storage.ensure_dirs()
        self.root: Path = storage.CONFIG_DIR / "profiles"
        # Se o perfil salvo não existe mais, volta ao padrão.
        self.active = active if active == DEFAULT or (self.root / active).is_dir() else DEFAULT

    # --------------------------------------------------------------- caminhos
    def dir_for(self, name: str) -> Path:
        return storage.CONFIG_DIR if name == DEFAULT else self.root / name

    def path(self, name: str, filename: str) -> Path:
        return self.dir_for(name) / filename

    # ---------------------------------------------------------------- leitura
    def list(self) -> list[str]:
        out = [DEFAULT]
        if self.root.is_dir():
            out.extend(sorted(p.name for p in self.root.iterdir() if p.is_dir()))
        return out

    def current(self) -> str:
        return self.active

    def exists(self, name: str) -> bool:
        return name in self.list()

    # ------------------------------------------------------------------ ações
    def create(self, name: str, template: str | None = None) -> str:
        """Cria um perfil. Sem template, copia os arquivos do perfil ativo;
        com template ('overwatch', 'darksouls', ...), escreve contadores e tema
        prontos do jogo. Retorna o slug."""
        slug = slugify(name)
        if not slug:
            raise ValueError("Nome de perfil inválido.")
        if slug == DEFAULT or self.exists(slug):
            raise ValueError(f"O perfil '{slug}' já existe.")
        if template and template not in TEMPLATES:
            raise ValueError(f"Template '{template}' não existe.")
        dest = self.root / slug
        dest.mkdir(parents=True, exist_ok=True)
        if template:
            t = TEMPLATES[template]
            storage.save_json(dest / "counters.json", {"counters": t["counters"]}, backup=False)
            storage.save_json(dest / "theme.json", dict(t["theme"]), backup=False)
            storage.save_json(dest / "hotkeys.json", {"enabled": False, "bindings": {}, "devices": []}, backup=False)
        else:
            src_dir = self.dir_for(self.active)
            for f in PROFILE_FILES:
                src = src_dir / f
                if src.exists():
                    shutil.copy2(src, dest / f)
        return slug

    def switch(self, name: str) -> str:
        if not self.exists(name):
            raise ValueError(f"Perfil '{name}' não existe.")
        self.active = name
        return name

    def delete(self, name: str) -> list[str]:
        if name == DEFAULT:
            raise ValueError("O perfil padrão não pode ser excluído.")
        if name == self.active:
            raise ValueError("Troque de perfil antes de excluir o ativo.")
        d = self.root / name
        if not d.is_dir():
            raise ValueError(f"Perfil '{name}' não existe.")
        shutil.rmtree(d)
        return self.list()
