#!/usr/bin/env bash
# run-tests.sh — the canonical way to run Forge Table's tests.
#
# WHY THIS EXISTS: CI runs three separate test jobs (see .gitlab-ci.yml: `web`, `bridge`, `e2e`), each with
# its own toolchain and its own 45m timeout. A contributor, or an automated code worker that only knows "run
# the repo's tests", otherwise has to reconstruct which job covers what. This script is that one entrypoint.
#
# STAGED ON PURPOSE. The full CI set takes the better part of an hour (Maven install alone is ~40m), which
# does not fit a single worker turn. So the default is the FAST, high-signal set, and the heavy jobs are
# named targets you opt into. A worker that changed Java should pass `bridge`; one that changed the web
# client should pass `web`; `all` is CI-equivalent and will usually be too slow for one turn.
#
# Usage:  ./run-tests.sh [target ...]      targets: web (default) | bridge | e2e | all | --list
# Exit:   0 all selected targets green, 1 any failure, 2 environment problem (missing toolchain).
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
web="$here/forge-gui-web"
MAVEN_CLI=(-B -ntp -Dcheckstyle.skip -Dmaven.javadoc.skip=true)

targets=( "$@" )
if [ ${#targets[@]} -eq 0 ]; then targets=( web ); fi

if [ "${targets[0]}" = "--list" ]; then
    cat <<'EOF'
web     (default)  npm ci + typecheck + unit tests   -- fast, no JVM
bridge             Maven build + forge-gui-bridge unit/contract tests -- slow (~40m)
e2e                Playwright end-to-end (needs `bridge` built first) -- slow
all                web + bridge + e2e, in that order -- CI-equivalent, will exceed one worker turn
EOF
    exit 0
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "run-tests.sh: '$1' not on PATH (needed for target '$2')." >&2; return 1; }; }
rc=0

run_web() {
    need npm web || return 2
    ( cd "$web" && npm ci && npm run typecheck && npm run test:unit ) || return 1
}
run_bridge() {
    need mvn bridge || return 2
    ( cd "$here" && mvn "${MAVEN_CLI[@]}" -Dskip.web -DskipTests install -pl forge-gui-bridge -am \
        && mvn "${MAVEN_CLI[@]}" -Dskip.web install -pl forge-gui-bridge ) || return 1
}
run_e2e() {
    need npm e2e || return 2
    need mvn e2e || return 2
    # the live-game sidecar finds classpath.txt and skips its own build, so the bridge must be built first
    ( cd "$here" && mvn "${MAVEN_CLI[@]}" -Dskip.web -DskipTests install -pl forge-gui-bridge -am ) || return 1
    ( cd "$web" && npm ci && npm run build && npm run test:e2e ) || return 1
}

for t in "${targets[@]}"; do
    case "$t" in
        web|bridge|e2e|all) ;;
        *) echo "run-tests.sh: unknown target '$t' (see --list)." >&2; exit 2 ;;
    esac
done

for t in "${targets[@]}"; do
    [ "$t" = all ] && set -- web bridge e2e || set -- "$t"
    for s in "$@"; do
        echo "== $s"
        case "$s" in
            web)    run_web ;;
            bridge) run_bridge ;;
            e2e)    run_e2e ;;
        esac
        r=$?
        if [ $r -eq 2 ]; then
            echo "run-tests.sh: '$s' could not run (toolchain missing) — NOT a green result." >&2
            rc=2
        elif [ $r -ne 0 ]; then
            echo "run-tests.sh: '$s' FAILED." >&2
            rc=1
        else
            echo "run-tests.sh: '$s' ok"
        fi
    done
    [ "$t" = all ] && break
done

[ $rc -eq 0 ] || echo "run-tests.sh: NOT all green (rc=$rc)."
exit $rc
