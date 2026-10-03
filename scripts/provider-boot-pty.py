"""Roda um PtySpawnSpec do Nexus (JSON na stdin) num PTY real por alguns segundos.

Usado só pelo smoke opt-in de boot de CLI (NEXUS_PROVIDER_BOOT_SMOKE=1, em
src/main/pty/pty-manager.test.ts). Spec e saída ficam em memória e voltam só
para quem chamou, que redige a saída antes de mostrar (o env pode ter
credencial). No prazo, o grupo de processos inteiro da CLI é encerrado:
o filho do pty.fork() lidera a própria sessão, então servidores e relaunches
que ela abriu morrem junto.

Saída (stdout): {"exitCode": int | null, "output": str}. exitCode null = a CLI
ainda estava viva no prazo (passou do boot).
"""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

spec = json.load(sys.stdin)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(spec["cwd"])
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", spec["rows"], spec["cols"], 0, 0))
    os.execve(spec["file"], [spec["file"], *spec["args"]], spec["env"])


def signal_cli(sig):
    # O filho direto sempre aceita sinal nosso; o grupo é melhor esforço (o
    # macOS responde EPERM se algum membro não puder ser sinalizado).
    for send in (lambda: os.kill(pid, sig), lambda: os.killpg(pid, sig)):
        try:
            send()
        except (ProcessLookupError, PermissionError):
            pass


output = bytearray()


def pump_until_exit(seconds):
    """Lê o PTY enquanto espera a saída: sem leitura, a CLI que escreve ao
    sair trava no fechamento do tty e nunca pode ser colhida."""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            if chunk:
                output.extend(chunk)
            else:
                time.sleep(0.05)  # PTY em hangup: não gira em falso até o waitpid
        waited, candidate = os.waitpid(pid, os.WNOHANG)
        if waited:
            return candidate
    return None


status = pump_until_exit(spec.get("seconds", 12))

if status is None:
    # Viva no prazo: passou do boot. Encerra a CLI e o grupo dela.
    signal_cli(signal.SIGTERM)
    if pump_until_exit(3) is None:
        signal_cli(signal.SIGKILL)
        pump_until_exit(5)
else:
    # Já saiu (e o pid foi colhido): só as sobras do grupo, nunca o pid.
    try:
        os.killpg(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
os.close(fd)
print(json.dumps({
    "exitCode": os.waitstatus_to_exitcode(status) if status is not None else None,
    "output": output.decode("utf-8", errors="replace"),
}))
