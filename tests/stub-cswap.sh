#!/bin/sh
# Fake cswap for tests. Driven by env vars:
#   STUB_STDOUT  — text to print on stdout
#   STUB_STDERR  — text to print on stderr
#   STUB_EXIT    — exit code (default 0)
#   STUB_SLEEP   — seconds to sleep before responding (default 0)
[ -n "$STUB_SLEEP" ] && sleep "$STUB_SLEEP"
[ -n "$STUB_STDOUT" ] && printf '%s' "$STUB_STDOUT"
[ -n "$STUB_STDERR" ] && printf '%s' "$STUB_STDERR" >&2
exit "${STUB_EXIT:-0}"
