#!/usr/bin/env python3
import json
import hashlib
import os
import sys
import time
from pathlib import Path

from provision import regular, require, write_new


def main():
    folder, command_file = map(Path, sys.argv[1:3])
    command = json.loads(regular(str(command_file), 32_768))
    require(isinstance(command, list) and command and all(isinstance(value, str) and value and "\0" not in value for value in command), "explicit argv command required")
    executable = Path(command[0])
    require(executable.is_absolute() and executable.resolve() == executable and executable.is_file(), "absolute real command executable required")
    require(executable.name not in {"sh", "bash", "zsh", "sudo", "su", "env"}, "shell/identity wrappers forbidden")
    pid = os.getpid()
    require(os.getpgid(pid) == pid, "workload must own its new process group")
    write_new(folder / "jobs" / (str(pid) + ".json"), {"pid": pid, "ppid": os.getppid(), "uid": os.getuid(), "argvSHA256": hashlib.sha256(json.dumps(command).encode()).hexdigest()})
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if (folder / "jobs" / (str(pid) + ".approved")).exists():
            os.execve(str(executable), command, dict(os.environ))
        time.sleep(0.05)
    raise RuntimeError("independent isolation lease did not approve this workload")


if __name__ == "__main__":
    main()
