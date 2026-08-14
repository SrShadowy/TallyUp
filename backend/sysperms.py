"""Permissões de sistema para ler o teclado no Linux (hotkeys via evdev).

No Linux, ler `/dev/input/event*` exige que o usuário esteja no grupo `input`.
Este módulo:
    - DETECTA se falta permissão (`input_status`);
    - CORRIGE pedindo a senha do sudo (ou via diálogo `pkexec`), rodando
      `usermod -aG input <user>` (persistente) e, quando possível, um
      `setfacl -m u:<user>:r /dev/input/event*` para liberar a leitura JÁ nesta
      sessão (sem precisar deslogar).

Segurança: a senha só é usada para executar o comando fixo abaixo, via stdin do
`sudo -S`. Ela NUNCA é gravada, logada ou devolvida. Os comandos são fixos — não
há execução de comando arbitrário. Tudo roda localmente.
"""

from __future__ import annotations

import glob
import os
import shlex
import shutil
import subprocess
import sys
from typing import Optional


def current_user() -> str:
    try:
        import getpass
        return getpass.getuser()
    except Exception:
        return os.environ.get("USER") or os.environ.get("LOGNAME") or "user"


def _device_paths() -> list[str]:
    return sorted(glob.glob("/dev/input/event*"))


def _is_root() -> bool:
    return hasattr(os, "geteuid") and os.geteuid() == 0


def input_status() -> dict:
    """Diagnóstico de permissão para ler o teclado."""
    linux = sys.platform.startswith("linux")
    st = {
        "linux": linux,
        "user": current_user(),
        "is_root": _is_root(),
        "sudo": bool(shutil.which("sudo")),
        "pkexec": bool(shutil.which("pkexec")),
        "setfacl": bool(shutil.which("setfacl")),
        "in_group_config": False,
        "in_group_session": False,
        "devices_found": False,
        "can_read": False,
        "needs_fix": False,
    }
    if not linux:
        return st

    try:
        import grp  # Unix-only
        g = grp.getgrnam("input")
        st["in_group_config"] = current_user() in g.gr_mem
        st["in_group_session"] = g.gr_gid in os.getgroups()
    except Exception:
        pass

    paths = _device_paths()
    readable_paths = [p for p in paths if os.access(p, os.R_OK)]
    st["devices_found"] = len(paths) > 0
    st["readable_devices"] = len(readable_paths)
    st["unreadable_devices"] = len(paths) - len(readable_paths)
    st["can_read"] = st["is_root"] or bool(readable_paths)
    st["needs_fix"] = linux and st["devices_found"] and not st["is_root"] and st["unreadable_devices"] > 0
    return st


def _inner_script(user: str, devs: list[str]) -> str:
    u = shlex.quote(user)
    lines = [f"usermod -aG input {u}"]
    if devs:
        quoted = " ".join(shlex.quote(d) for d in devs)
        # Libera a leitura JÁ nesta sessão (best-effort; ignora se faltar setfacl).
        lines.append(f"(command -v setfacl >/dev/null 2>&1 && setfacl -m u:{u}:r {quoted}) || true")
    return "\n".join(lines)


def fix_input_permissions(password: Optional[str]) -> dict:
    """Aplica a correção de permissão.

    password=None  -> usa `pkexec` (diálogo gráfico do sistema).
    password="..." -> usa `sudo -S` (senha via stdin).
    """
    if not sys.platform.startswith("linux"):
        return {"ok": False, "error": "Correção só é necessária no Linux."}

    st = input_status()
    if st["is_root"] or st["can_read"]:
        return {"ok": True, "already": True, "message": "Já há permissão de leitura do teclado."}
    if not st["devices_found"]:
        return {"ok": False, "error": "Nenhum dispositivo de teclado encontrado em /dev/input."}

    user = current_user()
    devs = _device_paths()
    script = _inner_script(user, devs)

    try:
        if password:
            if not shutil.which("sudo"):
                return {"ok": False, "error": "sudo não encontrado."}
            proc = subprocess.run(
                ["sudo", "-S", "-p", "", "sh", "-c", script],
                input=password + "\n", capture_output=True, text=True, timeout=60,
            )
        else:
            if not shutil.which("pkexec"):
                return {"ok": False, "error": "pkexec indisponível — informe a senha do sudo."}
            proc = subprocess.run(
                ["pkexec", "sh", "-c", script],
                capture_output=True, text=True, timeout=120,
            )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "Tempo esgotado ao solicitar a senha."}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        password = None  # não retém a senha

    if proc.returncode != 0:
        err = (proc.stderr or "").lower()
        if any(s in err for s in ("incorrect password", "sorry, try again", "authentication fail")):
            return {"ok": False, "error": "Senha incorreta."}
        if "not in the sudoers" in err:
            return {"ok": False, "error": "Seu usuário não tem permissão de sudo."}
        if proc.returncode == 126 or "dismissed" in err or "cancel" in err:
            return {"ok": False, "error": "Autorização cancelada."}
        return {"ok": False, "error": (proc.stderr or "Falha ao aplicar a correção.").strip()[:200]}

    after = input_status()
    immediate = after["can_read"]
    return {
        "ok": True,
        "added_group": True,
        "immediate": immediate,
        "needs_relogin": not immediate,
        "message": (
            "Permissão concedida — os atalhos já podem ser ativados."
            if immediate else
            "Adicionado ao grupo 'input'. Faça logout/login (ou reinicie) e reabra o app para ativar."
        ),
    }
