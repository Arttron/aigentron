# Runs inside a container (see scripts/test-infra.sh): backup.sh backup / restore on a fake data dir - paths, --with-repos, the version guard, the data-dir warning.
# Prints "MISSING" / "UNEXPECTED" on a failure; scripts/test-infra.sh turns those into a non-zero exit.
set -eu
B=/infra/backup.sh
mk() {  # a fake data dir
  d=$1; mkdir -p $d/secrets/projects/shop $d/agent/agents $d/agent/skills/core $d/agent/learned $d/agent/resources $d/agent/attachments/t1 $d/workspace/memory $d/projects/shop/memory $d/projects/shop/work $d/projects/shop/repo/src $d/projects/shop/repo/node_modules/x $d/repo/src $d/repo/node_modules/y $d/worktrees/shop/t1/src $d/worktrees/shop/t1/node_modules/z
  echo key > $d/secrets/projects/shop/id_ed25519; chmod 600 $d/secrets/projects/shop/id_ed25519
  echo agent > $d/agent/agents/a.md; echo notes > $d/projects/shop/memory/decisions.md; echo deliv > $d/projects/shop/work/d.txt
  echo code > $d/projects/shop/repo/src/a.js; echo nm > $d/projects/shop/repo/node_modules/x/i.js; echo code > $d/repo/src/b.js; echo nm > $d/repo/node_modules/y/i.js; echo wt > $d/worktrees/shop/t1/src/c.js; echo nm > $d/worktrees/shop/t1/node_modules/z/i.js
  echo att > $d/agent/attachments/t1/p.png; echo w > $d/workspace/memory/m.md
}
mk /d1
echo "== default backup"; APP_VERSION=0.1.85 sh $B backup /d1 /out/default.tar.gz 2>&1 | tail -2
tar -tzf /out/default.tar.gz | grep -E "projects/|repo|worktrees|MANIFEST" | sort
echo "== with repos"; APP_VERSION=0.1.85 sh $B backup /d1 /out/repos.tar.gz --with-repos 2>&1 | tail -1
tar -tzf /out/repos.tar.gz | grep -E "repo|worktrees|node_modules" | sort
echo "== manifest"; tar -xzOf /out/repos.tar.gz backups/.stage/MANIFEST
echo "== restore into a fresh dir (same version)"
mkdir -p /d2/backups; APP_VERSION=0.1.85 sh $B restore /d2 /out/repos.tar.gz 2>&1 | tail -3
for f in secrets/projects/shop/id_ed25519 projects/shop/memory/decisions.md projects/shop/work/d.txt repo/src/b.js worktrees/shop/t1/src/c.js agent/attachments/t1/p.png workspace/memory/m.md; do [ -f /d2/$f ] && echo "ok $f" || echo "MISSING $f"; done
[ -e /d2/repo/node_modules ] && echo "UNEXPECTED node_modules" || echo "ok no node_modules"
echo "== restore of a newer archive is refused"
mkdir -p /d3/backups; APP_VERSION=0.1.80 sh $B restore /d3 /out/default.tar.gz 2>&1 | tail -2 || true
echo "== --force passes"; APP_VERSION=0.1.80 sh $B restore /d3 /out/default.tar.gz --force 2>&1 | tail -2
echo "== other data dir warns"; mkdir -p /d4/backups; APP_VERSION=0.1.85 sh $B restore /d4 /out/default.tar.gz 2>&1 | grep -i "WARNING" | cut -c1-120
echo "== default backup has no repos on restore"; [ -e /d4/projects/shop/repo ] && echo "UNEXPECTED repo" || echo "ok: no checkout in default archive"
[ -f /d4/projects/shop/memory/decisions.md ] && echo "ok: project memory restored"
