#!/usr/bin/env python3
"""PreToolUse hook for Bash: deny `rm -f` with an explanation at the moment of use.

The global permission deny rules already block these commands, but a bare denial
teaches the model nothing. This hook denies first and supplies the *reason*, so the
model immediately understands the fix is to drop the `f` flag — not to retry,
escalate, or work around the block.
"""
import json
import re
import sys

REASON = (
    "Policy: `rm` may never be run with -f/--force in this environment, and any "
    "command containing that usage is denied in full. This is not a transient error "
    "and there is nothing to wait for or work around. The fix is simple: rerun the "
    "exact same command WITHOUT the f flag — plain `rm` and `rm -r` are allowed and "
    "work fine non-interactively. Do not substitute unlink, find -delete, or similar "
    "to bypass the block."
)

WRAPPERS = {"env", "command", "nice", "ionice", "nohup", "time", "xargs", "doas", "sudo"}


def rm_with_force(command: str) -> bool:
    # Evaluate each simple command in a compound line separately, so flags from
    # other programs (e.g. `grep -f`) never trigger a false positive.
    for segment in re.split(r"&&|\|\||;|\||\n", command):
        tokens = segment.strip().split()
        while tokens and (re.match(r"^\w+=", tokens[0]) or tokens[0] in WRAPPERS):
            tokens.pop(0)
        if not tokens or tokens[0] != "rm":
            continue
        for tok in tokens[1:]:
            if tok == "--":
                break
            if tok == "--force" or (tok.startswith("-") and not tok.startswith("--") and "f" in tok):
                return True
    return False


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    command = (data.get("tool_input") or {}).get("command", "")
    if isinstance(command, str) and rm_with_force(command):
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": REASON,
            }
        }))
    sys.exit(0)


if __name__ == "__main__":
    main()
