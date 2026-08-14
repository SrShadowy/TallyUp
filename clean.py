#!/usr/bin/env python3
"""TallyUp — limpeza de dados pessoais e temporários.

Remove tudo que é SEU (contadores, perfis, tema, hotkeys, backups, uploads,
logs e caches), deixando o projeto "de fábrica" — útil antes de publicar no
GitHub ou para recomeçar do zero. O código-fonte não é tocado; na próxima
execução o servidor recria os arquivos padrão sozinho.

Uso:
    python clean.py           # lista o que será apagado e pede confirmação
    python clean.py --yes     # apaga sem perguntar
    python clean.py --dry-run # só lista, não apaga nada
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def collect() -> list[Path]:
    """Junta todos os caminhos de dados pessoais/temporários existentes."""
    targets: list[Path] = []

    config = ROOT / "config"
    if config.is_dir():
        targets += sorted(config.glob("*.json"))      # counters, theme, hotkeys, config
        targets += sorted(config.glob("*.bak"))
        targets += sorted(config.glob("*.tmp"))
        for d in ("profiles", "backups"):
            p = config / d
            if p.is_dir():
                targets.append(p)

    uploads = ROOT / "assets" / "uploads"
    if uploads.is_dir():
        targets.append(uploads)

    targets += sorted(ROOT.glob("*.log"))             # hotkeys.log etc.

    # __pycache__ (fora do .venv)
    for p in ROOT.rglob("__pycache__"):
        if ".venv" not in p.parts:
            targets.append(p)

    return targets


def main() -> int:
    ap = argparse.ArgumentParser(description="Remove dados pessoais e temporários do TallyUp.")
    ap.add_argument("--yes", "-y", action="store_true", help="não pede confirmação")
    ap.add_argument("--dry-run", "-n", action="store_true", help="só lista, não apaga")
    args = ap.parse_args()

    targets = collect()
    if not targets:
        print("Nada para limpar — o projeto já está zerado. ✓")
        return 0

    print("Os seguintes dados serão APAGADOS:\n")
    for t in targets:
        kind = "pasta " if t.is_dir() else "arquivo"
        print(f"  [{kind}] {t.relative_to(ROOT)}")
    print(f"\nTotal: {len(targets)} itens.")

    if args.dry_run:
        print("(dry-run: nada foi apagado)")
        return 0

    if not args.yes:
        resp = input("\nConfirmar? Isso não pode ser desfeito. [s/N] ").strip().lower()
        if resp not in ("s", "sim", "y", "yes"):
            print("Cancelado.")
            return 1

    errors = 0
    for t in targets:
        try:
            if t.is_dir():
                shutil.rmtree(t)
            else:
                t.unlink()
        except OSError as e:
            errors += 1
            print(f"  ! não consegui apagar {t}: {e}")

    print(f"\nLimpeza concluída ({len(targets) - errors} itens removidos).")
    print("Na próxima execução do servidor, os arquivos padrão serão recriados.")
    return 0 if errors == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
