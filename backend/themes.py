"""Gerenciador de tema visual do overlay (theme.json).

Na Fase 1 o tema já é aplicado pelo overlay via variáveis CSS.
Nas fases futuras entra o Theme Editor visual — a estrutura abaixo
já contempla cores, fontes, espaçamento, sombras e animação.
"""

from __future__ import annotations

from typing import Any

from . import storage

THEME_FILE = "theme.json"

DEFAULT_THEME: dict[str, Any] = {
    "name": "Padrão",
    # Tamanho do canvas do overlay (por perfil). Padrão Full HD; use
    # 1080x1920 para overlay vertical, 3840x2160 para 4K etc.
    "canvas_width": 1920,
    "canvas_height": 1080,
    "layout": "vertical",          # vertical | horizontal
    "align": "left",              # left | center | right
    "font_family": "Inter, Segoe UI, Arial, sans-serif",
    "font_size": 48,
    "font_weight": 800,
    "letter_spacing": 0,
    "line_height": 1.1,
    "italic": False,
    "text_transform": "none",
    "text_color": "#ffffff",
    "label_color": "#c8f5d4",
    "accent_color": "#00e676",
    "value_color": "#ffffff",
    "page_background": "transparent",
    "card_background": "rgba(0, 0, 0, 0.55)",
    "card_border": "0px solid rgba(255,255,255,0.0)",
    "border_radius": 14,
    "padding": 16,
    "gap": 12,
    "shadow": "0 6px 18px rgba(0, 0, 0, 0.45)",
    "text_shadow": "2px 2px 6px rgba(0, 0, 0, 0.9)",
    "show_labels": True,
    "uppercase_labels": True,
    "value_animation": True,
    # --- personalização avançada (Fase 4) ---
    "card_background2": "",        # 2ª cor do gradiente ("" = sem gradiente)
    "card_gradient_dir": 180,      # direção do gradiente em graus
    "card_width": 0,               # largura fixa do card em px (0 = automática)
    "opacity": 100,                # opacidade do card em %
    "rotation": 0,                 # rotação em graus (-180..180)
    "text_stroke_width": 0,        # contorno do texto em px (0 = sem)
    "text_stroke_color": "#000000",
    "label_position": "left",      # left | right | top | bottom
    "text_align": "left",          # left | center | right
    # Win rate (macros %winrate% etc. e painel Stats): ids dos contadores.
    # Vazio = melhor esforço por nome (Vitórias/Wins, Derrotas/Losses).
    "winrate_w": "",
    "winrate_l": "",
    # Efeito padrão ao mudar valor ("none" desliga; cada elemento pode
    # sobrescrever no style.effect). Biblioteca em config/effects.json.
    "effect": "pop",
}


class ThemeManager:
    def __init__(self) -> None:
        storage.ensure_dirs()
        self._path = storage.config_path(THEME_FILE)
        self.data: dict[str, Any] = {}
        self.load()

    def load(self) -> dict[str, Any]:
        loaded = storage.load_json(self._path, default=None)
        if not isinstance(loaded, dict):
            self.data = dict(DEFAULT_THEME)
            self.save()
        else:
            merged = dict(DEFAULT_THEME)
            merged.update(loaded)
            self.data = merged
        return self.data

    def set_path(self, path) -> dict[str, Any]:
        """Aponta para outro arquivo (troca de perfil) e recarrega."""
        self._path = path
        return self.load()

    def save(self) -> None:
        storage.save_json(self._path, self.data, backup=True)

    def get(self) -> dict[str, Any]:
        return self.data

    def update(self, values: dict[str, Any]) -> dict[str, Any]:
        self.data.update(values)
        self.save()
        return self.data

    def reset(self) -> dict[str, Any]:
        self.data = dict(DEFAULT_THEME)
        self.save()
        return self.data
