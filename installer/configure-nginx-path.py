#!/usr/bin/env python3
"""Add or remove WebDeploy's include inside an existing Nginx virtual host."""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path


def uncomment(text: str) -> str:
    return re.sub(r"#[^\n]*", lambda match: " " * len(match.group(0)), text)


def server_blocks(text: str) -> list[tuple[int, int, str]]:
    clean = uncomment(text)
    blocks: list[tuple[int, int, str]] = []
    for match in re.finditer(r"\bserver\s*\{", clean):
        depth = 1
        cursor = match.end()
        while cursor < len(clean) and depth:
            if clean[cursor] == "{":
                depth += 1
            elif clean[cursor] == "}":
                depth -= 1
            cursor += 1
        if depth == 0:
            blocks.append((match.start(), cursor, text[match.start() : cursor]))
    return blocks


def declares_domain(block: str, domain: str) -> bool:
    for value in re.findall(r"\bserver_name\s+([^;]+);", uncomment(block)):
        if domain in value.split():
            return True
    return False


def is_https(block: str) -> bool:
    return any(re.search(r"(^|\s)443(\s|$)", value) for value in re.findall(r"\blisten\s+([^;]+);", uncomment(block)))


def candidate_files(root: Path) -> list[Path]:
    paths: dict[Path, Path] = {}
    for directory in (root / "sites-enabled", root / "conf.d"):
        if not directory.exists():
            continue
        for path in directory.rglob("*"):
            if path.is_file() and not path.name.endswith((".bak", "~")):
                resolved = path.resolve()
                paths.setdefault(resolved, resolved)
    return sorted(paths.values())


def find_vhost(root: Path, domain: str) -> tuple[Path, int, int, str] | None:
    matches: list[tuple[Path, int, int, str]] = []
    for path in candidate_files(root):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for start, end, block in server_blocks(text):
            if declares_domain(block, domain):
                matches.append((path, start, end, block))
    if not matches:
        return None
    return next((match for match in matches if is_https(match[3])), matches[0])


def atomic_write(path: Path, content: str) -> None:
    stat = path.stat()
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    os.chmod(temporary, stat.st_mode)
    os.replace(temporary, path)


def add_include(path: Path, start: int, end: int, block: str, include: str, public_path: str) -> None:
    directive = f"include {include};"
    if directive in block:
        print(path)
        return
    escaped_path = re.escape(public_path)
    if re.search(rf"\blocation\s+(?:\^~\s+|=\s+)?{escaped_path}(?:/|\s|\{{)", uncomment(block)):
        raise RuntimeError(f"Nginx location {public_path} already exists in {path}")
    closing = end - 1
    text = path.read_text(encoding="utf-8")
    backup_directory = path.parent.parent / "webdeploy-backups"
    backup_directory.mkdir(mode=0o700, exist_ok=True)
    backup = backup_directory / f"{path.name}.webdeploy.bak"
    if not backup.exists():
        shutil.copy2(path, backup)
    insertion = f"\n    # Managed by WebDeploy MCP.\n    {directive}\n"
    atomic_write(path, f"{text[:closing]}{insertion}{text[closing:]}")
    print(path)


def remove_include(path: Path, include: str) -> None:
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8")
    pattern = re.compile(
        rf"\n?[ \t]*# Managed by WebDeploy MCP\.\n[ \t]*include\s+{re.escape(include)};\n?"
    )
    updated = pattern.sub("\n", text)
    if updated != text:
        atomic_write(path, updated)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--domain")
    parser.add_argument("--nginx-root", default="/etc/nginx")
    parser.add_argument("--include", required=True)
    parser.add_argument("--path", default="/webdeploy")
    parser.add_argument("--remove-from")
    args = parser.parse_args()

    if args.remove_from:
        remove_include(Path(args.remove_from), args.include)
        return 0
    if not args.domain:
        parser.error("--domain is required unless --remove-from is used")
    match = find_vhost(Path(args.nginx_root), args.domain)
    if not match:
        return 3
    add_include(*match, args.include, args.path)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(error, file=sys.stderr)
        raise SystemExit(2)
