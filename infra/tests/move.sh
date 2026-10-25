# Runs inside a container (see scripts/test-infra.sh): `aigentron export` on install A, `aigentron import` on install B (systemctl is stubbed).
set -eu
mkdir -p /usr/local/bin
printf '#!/bin/sh\necho "[systemctl $*]"\n' > /usr/local/bin/systemctl; chmod +x /usr/local/bin/systemctl
render() {  # $1 = install dir  $2 = data dir  $3 = out
  mkdir -p "$1/current/infra" "$1/current/apps/orchestrator" "$2"
  cp /infra/backup.sh /infra/db-snapshot.sh "$1/current/infra/"; echo "$4" > "$1/current/VERSION"; : > "$1/.env"
  sed -e "s#__MODE__#bare#; s#__CURRENT__#$1/current#; s#__CONTAINER__#x#; s#__DATA_DIR__#$2#; s#__INSTALL_DIR__#$1#" /infra/aigentron-cli.sh > "$3"; chmod +x "$3"
}
render /srv/a /srv/a/data /usr/local/bin/aigentron-a 0.1.85
render /srv/b /srv/a/data /usr/local/bin/aigentron-b 0.1.85   # same data dir path semantics tested separately; B uses its own install dir
rm -rf /srv/b/data; mkdir -p /srv/b/data
sed -i "s#/srv/a/data#/srv/b/data#" /usr/local/bin/aigentron-b
D=/srv/a/data
mkdir -p $D/secrets/projects/shop $D/projects/shop/memory $D/projects/shop/repo/src $D/repo/src $D/repo/node_modules/q $D/worktrees/shop/t1 $D/agent/agents
echo k > $D/secrets/projects/shop/id_ed25519; echo m > $D/projects/shop/memory/decisions.md; echo c > $D/projects/shop/repo/src/a.js; echo d > $D/repo/src/b.js; echo n > $D/repo/node_modules/q/i; echo a > $D/agent/agents/x.md
echo "######## export on A"; aigentron-a export /tmp/move.tar.gz 2>&1 | tail -9
tar -tzf /tmp/move.tar.gz | grep -E "repo|node_modules|projects/shop/memory" | sort
echo "######## import on B (answers yes)"; echo yes | aigentron-b import /tmp/move.tar.gz 2>&1 | tail -14
for f in secrets/projects/shop/id_ed25519 projects/shop/memory/decisions.md projects/shop/repo/src/a.js repo/src/b.js agent/agents/x.md; do [ -f /srv/b/data/$f ] && echo "ok $f" || echo "MISSING $f"; done
[ -e /srv/b/data/repo/node_modules ] && echo UNEXPECTED || echo "ok no node_modules"
echo "######## backup without repos"; aigentron-a backup /tmp/b.tar.gz 2>&1 | tail -2; tar -tzf /tmp/b.tar.gz | grep -c "repo/" || true
echo "######## export --no-repos"; aigentron-a export /tmp/e2.tar.gz --no-repos 2>&1 | head -2; tar -tzf /tmp/e2.tar.gz | grep -c "/repo\|^repo" || true
echo "######## bad option"; aigentron-a backup --bogus 2>&1 | tail -1 || true
