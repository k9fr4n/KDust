# Python venv pattern in KDust

Debian bookworm enforces PEP 668: the system Python refuses `pip install`
outside a virtual environment with the error
`error: externally-managed-environment`. Don't fight it. Use a venv per project.

## Standard recipe

From the project workspace:

```bash
# 1. Create the venv once
python3 -m venv .venv

# 2. Activate it (subsequent commands)
. .venv/bin/activate

# 3. Install
pip install --upgrade pip
pip install -r requirements.txt    # or: pip install <pkgs>

# 4. Run
python script.py
```

In a single `run_command` you cannot rely on shell state persisting across
calls (each call is `execFile`, not a shell session). Use one of:

```bash
# Option A: chain in one call
bash -c '. .venv/bin/activate && python script.py'

# Option B: call the venv interpreter directly (preferred, no shell needed)
.venv/bin/python script.py
.venv/bin/pip install -r requirements.txt
```

Option B is robust and works with `command-runner`'s `execFile` model
(no shell required, no quoting issues).

## .gitignore

Add to the project's `.gitignore`:

```
.venv/
__pycache__/
*.pyc
```

## Reusing an existing venv

```bash
test -x .venv/bin/python || python3 -m venv .venv
.venv/bin/pip install --quiet -r requirements.txt
.venv/bin/python script.py
```

Idempotent, safe to run on every task execution.

## What NOT to do

- `pip install --break-system-packages` — works but pollutes the container
  globally and breaks the next agent's assumptions.
- `pip install --user` — same issue, and `$HOME` is `/home/node` shared
  across all tasks running in the container.
- `pipx` — not installed; would need the same venv anyway.
- `conda` / `mamba` — not installed.
- `apt-get install python3-<pkg>` — no root, can't.

## Tooling versions

```bash
python3 --version       # 3.11.x (bookworm)
.venv/bin/pip --version # whatever pip ships with the active 3.11
```

If a project pins a different Python version, the runner image won't provide
it — flag this to the user; we'd need a Dockerfile change.
