"""hotkeys.py — normalização de combos e conversões (não precisa de teclado)."""

from backend.hotkeys import evdev_token, normalize_combo, to_pynput


def test_normalize_basic():
    assert normalize_combo("CTRL+F1") == "ctrl+f1"
    assert normalize_combo("Control+Shift+A") == "ctrl+shift+a"


def test_normalize_mod_order_is_canonical():
    # shift antes de ctrl vira ctrl+shift (ordem fixa: ctrl alt shift meta)
    assert normalize_combo("shift+ctrl+x") == "ctrl+shift+x"
    assert normalize_combo("meta+alt+k") == "alt+meta+k"


def test_normalize_aliases():
    assert normalize_combo("cmd+c") == "meta+c"
    assert normalize_combo("win+d") == "meta+d"
    assert normalize_combo("option+e") == "alt+e"


def test_normalize_legacy_chars():
    assert normalize_combo("ctrl+=") == "ctrl+equal"
    assert normalize_combo("ctrl++") == "ctrl+equal"
    assert normalize_combo("ctrl+-") == "ctrl+minus"


def test_normalize_empty_and_invalid():
    assert normalize_combo("") is None
    assert normalize_combo(None) is None
    assert normalize_combo("ctrl+") is None


def test_normalize_idempotent():
    once = normalize_combo("Shift+Ctrl+F5")
    assert normalize_combo(once) == once


def test_to_pynput():
    assert to_pynput("ctrl+f1") == "<ctrl>+<f1>"
    assert to_pynput("ctrl+shift+a") == "<ctrl>+<shift>+a"
    assert to_pynput("meta+space") == "<cmd>+<space>"
    assert to_pynput("numpad5") == "5"


def test_evdev_token():
    assert evdev_token("KEY_A") == "a"
    assert evdev_token("KEY_F12") == "f12"
    assert evdev_token("KEY_KPPLUS") == "numpadadd"
    assert evdev_token(["KEY_ENTER", "KEY_KPENTER"]) == "enter"  # lista -> 1º nome
    assert evdev_token("BTN_LEFT") is None
    assert evdev_token(None) is None
