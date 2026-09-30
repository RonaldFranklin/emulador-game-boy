#!/usr/bin/env python3
"""Exercise the actual bootstrap command in a PTY without exposing its password.

Usage: python3 tests/bootstrap-cli.py emulador_test_<random>
Read {"username": "...", "password": "..."} from stdin; never pass a password
as a command argument or environment variable. The caller owns the isolated DB.
Set BOOTSTRAP_LOCAL=1 inside the browser test container to invoke the CLI locally.
"""

import errno
import json
import os
from pathlib import Path
import pty
import re
import selectors
import signal
import subprocess
import sys
import time


def main():
    if len(sys.argv) != 2 or not re.fullmatch(
        r"emulador_(?:test|browser|ui|restore)_[a-z0-9_]{8,40}", sys.argv[1]
    ):
        raise ValueError("Informe somente o nome de uma base efêmera de teste.")
    credentials = json.load(sys.stdin)
    username = credentials.get("username")
    password = credentials.get("password")
    if not isinstance(username, str) or not re.fullmatch(r"[a-z0-9_]{3,32}", username):
        raise ValueError("Nome de usuário de teste inválido.")
    if not isinstance(password, str) or not 12 <= len(password) <= 128:
        raise ValueError("Senha de teste inválida.")
    if any(char in password for char in ("\n", "\r", "\x00", "\x03", "\x04")):
        raise ValueError("A senha de teste não pode conter controles de terminal.")

    primary, secondary = pty.openpty()
    environment = os.environ.copy()
    if environment.get("BOOTSTRAP_LOCAL") == "1":
        environment["PGDATABASE"] = sys.argv[1]
        command = ["npm", "run", "bootstrap:master", "--workspace", "backend"]
    else:
        command = [
            "docker", "compose", "run", "--rm", "--no-deps",
            "-e", f"PGDATABASE={sys.argv[1]}", "test",
            "npm", "run", "bootstrap:master", "--workspace", "backend",
        ]
    child = subprocess.Popen(
        command,
        cwd=Path(__file__).resolve().parent.parent,
        stdin=secondary,
        stdout=secondary,
        stderr=secondary,
        env=environment,
        close_fds=True,
        start_new_session=True,
    )
    os.close(secondary)
    selector = selectors.DefaultSelector()
    selector.register(primary, selectors.EVENT_READ)
    transcript = ""
    stage = 0
    consumed = 0
    prompts = [
        (re.compile(r"(?:Nome de usu[aá]rio|Usu[aá]rio)[^:\n]*:\s*", re.I), username),
        (re.compile(r"Senha[^:\n]*:\s*", re.I), password),
        (re.compile(r"(?:Confirme|Confirma[çc][aã]o)[^:\n]*:\s*", re.I), password),
    ]
    deadline = time.monotonic() + 45
    failure = None
    try:
        while time.monotonic() < deadline:
            ready = selector.select(0.2)
            if not ready and child.poll() is not None:
                break
            if not ready:
                continue
            try:
                data = os.read(primary, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            transcript += data.decode("utf-8", errors="replace")
            if len(transcript) > 1_000_000:
                failure = "Saída do bootstrap excedeu o limite do teste."
                break
            if stage < len(prompts):
                pattern, answer = prompts[stage]
                match = pattern.search(transcript, consumed)
                if match:
                    consumed = match.end()
                    os.write(primary, answer.encode("utf-8") + b"\n")
                    stage += 1
        else:
            failure = "Bootstrap não concluiu em 45 segundos."
        if child.poll() is None:
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                failure = failure or "Bootstrap deixou o terminal aberto."
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        selector.close()
        os.close(primary)

    if password in transcript:
        failure = "A senha foi ecoada no terminal; bootstrap reprovado."
    elif child.returncode != 0:
        # Keep failures actionable while removing any accidental secret output.
        sanitized = transcript.replace(password, "[senha omitida]")[-1800:]
        failure = failure or f"Bootstrap retornou {child.returncode}: {sanitized}"
    elif stage != 3:
        failure = "O comando não realizou as três perguntas esperadas."
    if failure:
        print(json.dumps({"ok": False, "error": failure}, ensure_ascii=False))
        return 1
    print(json.dumps({"ok": True, "username": username, "passwordEchoed": False}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
