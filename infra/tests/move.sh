# Runs inside a container (see scripts/test-infra.sh): `aigentron export` on install A, `aigentron import` on install B (systemctl is stubbed). Failures print MISSING / UNEXPECTED / FAIL.
set -eu
mkdir -p /usr/local/bin
printf '#!/bin/sh\necho "[systemctl $*]"\n' > /usr/local/bin/systemctl; chmod +x /usr/local/bin/systemctl
render() {  # $1 = install dir  $2 = data dir  $3 = out  $4 = version
  mkdir -p "$1/current/infra" "$1/current/apps/orchestrator" "$2"
  cp /infra/backup.sh /infra/db-snapshot.sh "$1/current/infra/"; echo "$4" > "$1/current/VERSION"; : > "$1/.env"
  sed -e "s#__MODE__#bare#; s#__CURRENT__#$1/current#; s#__CONTAINER__#x#; s#__DATA_DIR__#$2#; s#__INSTALL_DIR__#$1#" /infra/aigentron-cli.sh > "$3"; chmod +x "$3"
}
render /srv/a /srv/a/data /usr/local/bin/aigentron-a 0.1.85
render /srv/b /srv/b/data /usr/local/bin/aigentron-b 0.1.85
render /srv/c /srv/c/data /usr/local/bin/aigentron-c 0.1.80   # an older server
D=/srv/a/data
mkdir -p $D/secrets/projects/shop $D/projects/shop/memory $D/projects/shop/repo/src $D/repo/src $D/repo/node_modules/q $D/worktrees/shop/t1 $D/agent/agents $D/workspace/build
echo k > $D/secrets/projects/shop/id_ed25519; echo m > $D/projects/shop/memory/decisions.md; echo c > $D/projects/shop/repo/src/a.js; echo d > $D/repo/src/b.js; echo n > $D/repo/node_modules/q/i; echo a > $D/agent/agents/x.md; echo r > $D/workspace/build/report.md
echo "== export to a path with a space"
mkdir -p "/tmp/my dir"
aigentron-a export "/tmp/my dir/move.tar.gz" >/dev/null 2>&1 || echo "FAIL export"
[ -s "/tmp/my dir/move.tar.gz" ] && echo "ok the archive is where it was asked" || echo "MISSING /tmp/my dir/move.tar.gz"
[ -e dir/move.tar.gz ] && echo "UNEXPECTED a relative 'dir/move.tar.gz' was written" || echo "ok nothing written at a split path"
echo "== import on B"
echo yes | aigentron-b import "/tmp/my dir/move.tar.gz" >/dev/null 2>&1 || echo "FAIL import"
for f in secrets/projects/shop/id_ed25519 projects/shop/memory/decisions.md projects/shop/repo/src/a.js repo/src/b.js agent/agents/x.md workspace/build/report.md; do [ -f /srv/b/data/$f ] && echo "ok $f" || echo "MISSING $f"; done
[ -e /srv/b/data/repo/node_modules ] && echo "UNEXPECTED node_modules" || echo "ok no node_modules"
echo "== options"
aigentron-a export /tmp/e2.tar.gz --no-repos >/dev/null 2>&1; tar -tzf /tmp/e2.tar.gz | grep -q "^repo/\|repos.tar.gz" && echo "UNEXPECTED code in a --no-repos export" || echo "ok --no-repos has no code"
if aigentron-a export --to >/tmp/to.out 2>&1; then echo "UNEXPECTED --to without a value accepted"; else grep -q "needs a destination" /tmp/to.out && echo "ok --to without a value is explained" || echo "FAIL --to message: $(cat /tmp/to.out)"; fi
if aigentron-a backup --bogus >/tmp/bo.out 2>&1; then echo "UNEXPECTED bad option accepted"; else grep -q "unknown option" /tmp/bo.out && echo "ok bad option refused" || echo "FAIL bad option text"; fi
echo "== restore flags in any order, and the version guard through the CLI"
if echo yes | aigentron-c restore "/tmp/my dir/move.tar.gz" >/tmp/v.out 2>&1; then echo "UNEXPECTED a newer archive was restored by an older server"; else grep -q "newer than the installed" /tmp/v.out && echo "ok older server refuses" || echo "FAIL refusal text"; fi
echo yes | aigentron-c restore --force "/tmp/my dir/move.tar.gz" >/dev/null 2>&1 && echo "ok --force before the file" || echo "FAIL --force before the file"
