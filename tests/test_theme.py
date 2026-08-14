"""themes.py — defaults (incl. personalização avançada), merge e reset."""

from backend.themes import DEFAULT_THEME, ThemeManager

ADVANCED_KEYS = (
    "card_background2", "card_gradient_dir", "card_width", "opacity",
    "rotation", "text_stroke_width", "text_stroke_color",
    "label_position", "text_align",
)


def test_defaults_have_advanced_keys(tmp_storage):
    t = ThemeManager().get()
    for k in ADVANCED_KEYS:
        assert k in t, k
    assert t["opacity"] == 100 and t["rotation"] == 0


def test_defaults_canvas_size(tmp_storage):
    t = ThemeManager().get()
    assert t["canvas_width"] == 1920 and t["canvas_height"] == 1080


def test_canvas_size_update(tmp_storage):
    m = ThemeManager()
    m.update({"canvas_width": 1080, "canvas_height": 1920})  # vertical
    m2 = ThemeManager()
    assert m2.get()["canvas_width"] == 1080 and m2.get()["canvas_height"] == 1920


def test_partial_file_is_merged_with_defaults(tmp_storage):
    m = ThemeManager()
    m.update({"font_size": 60})
    m2 = ThemeManager()          # recarrega do disco
    assert m2.get()["font_size"] == 60
    assert m2.get()["label_position"] == DEFAULT_THEME["label_position"]


def test_reset_restores_defaults(tmp_storage):
    m = ThemeManager()
    m.update({"rotation": 45, "opacity": 10})
    m.reset()
    assert m.get()["rotation"] == 0 and m.get()["opacity"] == 100


def test_config_has_single_version_source(tmp_storage):
    """A versão vive só em backend.__version__; config.json não deve tê-la."""
    from backend import __version__, storage
    from backend.config import ConfigManager

    # config antigo com "version" é migrado (chave removida)
    storage.save_json(storage.config_path("config.json"), {"version": "0.9", "port": 3210})
    cfg = ConfigManager()
    assert "version" not in cfg.data
    assert "version" not in (storage.load_json(storage.config_path("config.json")) or {})
    assert __version__  # fonte única existe


def test_theme_winrate_keys(tmp_storage):
    t = ThemeManager()
    assert t.get()["winrate_w"] == "" and t.get()["winrate_l"] == ""
    t.update({"winrate_w": "c-abc", "winrate_l": "c-def"})
    t2 = ThemeManager()
    assert t2.get()["winrate_w"] == "c-abc" and t2.get()["winrate_l"] == "c-def"
