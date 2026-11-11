"""Runs a command on a pseudo-terminal and answers its prompts — for scripts that refuse a non-TTY stdin.

Usage: _pty_drive.py <answers-file> <prompt-marker> <output-file> <command> [args...]
- each new occurrence of the marker in the output gets the next line of the answers file, so a line is
  never typed before an echo-off read starts (typed early, the terminal would echo it)
- the full terminal output goes to the output file; the exit status is the command's own (124 on timeout)
"""

import os
import pty
import select
import sys
import time

TIMEOUT_S = 60


def main() -> int:
    answers_path, marker, output_path, *command = sys.argv[1:]
    with open(answers_path, encoding="utf-8") as answers_file:
        answers = answers_file.read().splitlines()
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(command[0], command)
    output, is_timed_out = drive(fd, answers, marker.encode())
    with open(output_path, "wb") as output_file:
        output_file.write(output)
    if is_timed_out:
        os.kill(pid, 9)
    _, status = os.waitpid(pid, 0)
    return 124 if is_timed_out else os.waitstatus_to_exitcode(status)


def drive(fd: int, answers: list[str], marker: bytes) -> tuple[bytes, bool]:
    output = b""
    answered = 0
    deadline = time.monotonic() + TIMEOUT_S
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 4096)
        except OSError:  # EIO on Linux once the child side closes
            return output, False
        if not chunk:
            return output, False
        output += chunk
        while output.count(marker) > answered and answered < len(answers):
            os.write(fd, answers[answered].encode() + b"\n")
            answered += 1
    return output, True


if __name__ == "__main__":
    sys.exit(main())
