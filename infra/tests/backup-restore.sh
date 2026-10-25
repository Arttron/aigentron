# Runs inside a container (see scripts/test-infra.sh): backup.sh backup / restore on a fake data dir. Every check prints MISSING / UNEXPECTED / FAIL on a failure;
# scripts/test-infra.sh turns those into a non-zero exit.
set -eu
B=/infra/backup.sh
has() { [ -e "$1" ] && echo "ok $2" || echo "MISSING $2"; }
hasnt() { [ -e "$1" ] && echo "UNEXPECTED $2" || echo "ok $2"; }
member() { tar -tzf "$1" | grep -q "^$2\$" && echo "ok in archive: $2" || echo "MISSING in archive: $2"; }
nomember() { tar -tzf "$1" | grep -q "^$2\$" && echo "UNEXPECTED in archive: $2" || echo "ok not in archive: $2"; }
mk() {  # a fake data dir
  d=$1
  mkdir -p $d/secrets/projects/shop $d/agent/agents $d/agent/skills/custom/build $d/agent/learned $d/agent/resources $d/agent/attachments/t1/dist $d/workspace/memory $d/workspace/build $d/workspace/library/dist $d/workspace/projects/x/repo
  mkdir -p $d/projects/shop/memory $d/projects/shop/work/demo/repo $d/projects/shop/deliverables/build $d/projects/shop/repo/src $d/projects/shop/repo/node_modules/x $d/repo/src $d/repo/node_modules/y $d/repo/dist $d/worktrees/shop/t1/src $d/worktrees/shop/t1/node_modules/z
  echo key > $d/secrets/projects/shop/id_ed25519
  echo skill > $d/agent/skills/custom/build/SKILL.md; echo att > $d/agent/attachments/t1/dist/p.png; echo r > $d/workspace/build/report.md; echo z > $d/workspace/library/dist/site.zip
  echo n > $d/workspace/projects/x/repo/notes.md; echo m > $d/workspace/memory/m.md
  echo notes > $d/projects/shop/memory/decisions.md; echo demo > $d/projects/shop/work/demo/repo/README.md; echo out > $d/projects/shop/deliverables/build/out.pdf
  echo code > $d/projects/shop/repo/src/a.js; echo nm > $d/projects/shop/repo/node_modules/x/i.js
  echo code > $d/repo/src/b.js; echo nm > $d/repo/node_modules/y/i.js; echo tracked > $d/repo/dist/tracked.js; echo wt > $d/worktrees/shop/t1/src/c.js; echo nm > $d/worktrees/shop/t1/node_modules/z/i.js
}
mk /d1

echo "== default backup: data is whole, the project checkout is out (and only that one)"
APP_VERSION=0.1.85 sh $B backup /d1 /out/default.tar.gz >/dev/null 2>&1 || echo "FAIL backup"
for m in projects/shop/memory/decisions.md projects/shop/work/demo/repo/README.md projects/shop/deliverables/build/out.pdf workspace/build/report.md workspace/library/dist/site.zip workspace/projects/x/repo/notes.md agent/attachments/t1/dist/p.png agent/skills/custom/build/SKILL.md secrets/projects/shop/id_ed25519; do member /out/default.tar.gz "$m"; done
nomember /out/default.tar.gz projects/shop/repo/src/a.js
nomember /out/default.tar.gz repo/src/b.js

echo "== export (--with-repos): the same data plus the code, without node_modules"
APP_VERSION=0.1.85 sh $B backup /d1 /out/repos.tar.gz --with-repos >/dev/null 2>&1 || echo "FAIL export backup"
for m in workspace/build/report.md workspace/library/dist/site.zip projects/shop/deliverables/build/out.pdf agent/attachments/t1/dist/p.png agent/skills/custom/build/SKILL.md projects/shop/work/demo/repo/README.md workspace/projects/x/repo/notes.md; do member /out/repos.tar.gz "$m"; done
tar -xzOf /out/repos.tar.gz backups/.stage/MANIFEST | grep -q '^repos=yes' && echo "ok manifest repos=yes" || echo "MISSING manifest repos=yes"
tar -xzOf /out/repos.tar.gz backups/.stage/repos.tar.gz > /tmp/inner.tgz
for m in repo/src/b.js repo/dist/tracked.js projects/shop/repo/src/a.js worktrees/shop/t1/src/c.js; do member /tmp/inner.tgz "$m"; done
nomember /tmp/inner.tgz repo/node_modules/y/i.js
nomember /tmp/inner.tgz projects/shop/repo/node_modules/x/i.js
nomember /tmp/inner.tgz worktrees/shop/t1/node_modules/z/i.js

echo "== restore an export into a fresh dir"
mkdir -p /d2/backups; APP_VERSION=0.1.85 sh $B restore /d2 /out/repos.tar.gz >/dev/null 2>&1 || echo "FAIL restore"
for f in secrets/projects/shop/id_ed25519 projects/shop/memory/decisions.md projects/shop/deliverables/build/out.pdf workspace/build/report.md agent/attachments/t1/dist/p.png projects/shop/repo/src/a.js repo/src/b.js repo/dist/tracked.js worktrees/shop/t1/src/c.js; do has /d2/$f "restored $f"; done
hasnt /d2/repo/node_modules "no node_modules after restore"

echo "== restore an ORDINARY backup over a server that has its checkout: the checkout stays"
mkdir -p /d5/projects/shop/repo/src /d5/projects/shop/memory /d5/backups; echo unpushed > /d5/projects/shop/repo/src/unpushed.js; echo old > /d5/projects/shop/memory/old.md
APP_VERSION=0.1.85 sh $B restore /d5 /out/default.tar.gz >/dev/null 2>&1 || echo "FAIL ordinary restore"
has /d5/projects/shop/repo/src/unpushed.js "the existing checkout is untouched"
has /d5/projects/shop/memory/decisions.md "the project's memory came back"
has "$(ls -d /d5/backups/before-restore-*/projects/shop/memory/old.md 2>/dev/null | head -1)" "the replaced memory file is kept aside"

echo "== restoring an export replaces the checkout and keeps the old one aside"
mkdir -p /d6/projects/shop/repo /d6/backups; echo oldcode > /d6/projects/shop/repo/old.js
APP_VERSION=0.1.85 sh $B restore /d6 /out/repos.tar.gz >/dev/null 2>&1 || echo "FAIL export restore over a checkout"
has /d6/projects/shop/repo/src/a.js "the exported checkout is in place"
has "$(ls -d /d6/backups/before-restore-*/projects/shop/repo/old.js 2>/dev/null | head -1)" "the old checkout is kept aside"

echo "== the version guard"
mkdir -p /d3/backups
if APP_VERSION=0.1.80 sh $B restore /d3 /out/default.tar.gz >/tmp/g.out 2>&1; then echo "UNEXPECTED newer archive accepted"; else grep -q "newer than the installed" /tmp/g.out && echo "ok newer archive refused" || echo "FAIL refusal text: $(cat /tmp/g.out)"; fi
APP_VERSION=0.1.80 sh $B restore /d3 /out/default.tar.gz --force >/dev/null 2>&1 && echo "ok --force passes" || echo "FAIL --force"

echo "== another data dir warns"
mkdir -p /d4/backups
APP_VERSION=0.1.85 sh $B restore /d4 /out/default.tar.gz 2>&1 | grep -q "WARNING the archive comes from a server whose data folder was /d1" && echo "ok warning" || echo "FAIL no data-dir warning"
