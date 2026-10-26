import { describe, expect, it } from 'vitest';
import { analyzeShell, isMainRef, splitCommands, tokenize } from './shell-guard';

const f = (c: string, cwd: string | null = '/work/tree') => analyzeShell(c, cwd);
const paths = (c: string, cwd: string | null = '/work/tree') => f(c, cwd).mutated.map((m) => m.path);

describe('reading a command line', () => {
  it('splits on separators outside quotes, drops heredoc bodies and comments', () => {
    expect(splitCommands('a && b; c | d\ne')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(splitCommands(`echo "a;b" && echo 'c|d'`)).toEqual([`echo "a;b"`, `echo 'c|d'`]);
    expect(splitCommands('cat > x <<EOF\nrm -rf /etc\nEOF\nls')).toEqual(['cat > x <<EOF', 'ls']);
    expect(splitCommands('ls # rm -rf /')).toEqual(['ls']);
    expect(splitCommands('git push origin \\\n main')).toEqual(['git push origin   main']);
    expect(splitCommands('cmd 2>&1 | tee log')).toEqual(['cmd 2>&1', 'tee log']);
  });
  it('tokenizes with quotes removed and marks what the shell would expand', () => {
    expect(tokenize(`git push origin "main"`).map((t) => t.text)).toEqual(['git', 'push', 'origin', 'main']);
    expect(tokenize(`rm -rf $HOME/x ~/y '$z'`).map((t) => [t.text, t.dynamic])).toEqual([['rm', false], ['-rf', false], ['$HOME/x', true], ['~/y', true], ['$z', false]]);
  });
  it('main / master refs in the usual spellings', () => {
    for (const r of ['main', 'master', 'origin/main', 'HEAD:main', '+refs/heads/main', 'x:refs/heads/master', 'refs/remotes/origin/main']) expect(isMainRef(r), r).toBe(true);
    for (const r of ['feature/main', 'maintenance', 'develop', 'main-page', 'HEAD']) expect(isMainRef(r), r).toBe(false);
  });
});

describe('merge', () => {
  it('git merge in every spelling, gh pr merge, the API merge', () => {
    for (const c of ['git merge feature', 'git -C /work/tree merge origin/develop', 'git --no-pager merge x', 'git -c core.editor=true merge x', 'git pull origin develop', 'gh pr merge 12 --squash', 'gh api -X PUT repos/o/r/pulls/3/merge', "sh -c 'git merge x'", 'echo $(git merge y)'])
      expect(f(c).merge, c).toBe(true);
  });
  it('not merges', () => {
    for (const c of ['git merge --abort', 'git merge-base main HEAD', 'git commit -m "merge main into feature"', 'git pull --rebase origin develop', 'git log --merges', 'echo merge'])
      expect(f(c).merge, c).toBe(false);
  });
});

describe('merging the agent\'s own task branches', () => {
  const W = '/opt/aigentron/data/worktrees/p/t1';
  it('is routine inside a task worktree', () => {
    expect(analyzeShell('git merge --no-edit agent/task-abc1 agent/task-abc2', W).merge).toBe(false);
    expect(analyzeShell('git merge agent/fix-login-button-s5p85b', W).merge).toBe(false);
    expect(analyzeShell(`cd ${W}; git merge agent/task-abc1 2>&1 | tail -2`, null).merge).toBe(false);
  });
  it('is still asked about elsewhere, with other refs, or into main', () => {
    expect(analyzeShell('git merge agent/task-abc1', '/srv/repo').merge).toBe(true);
    expect(analyzeShell('git merge agent/task-abc1 feature', W).merge).toBe(true);
    expect(analyzeShell('git merge agent/task-abc1 main', W).mainBranch).toBe(true);
    expect(analyzeShell('git merge agent/task-$X', W).merge).toBe(true);
  });
});

describe('main / master', () => {
  it('pushes, resets, checkouts and the like that name it', () => {
    for (const c of ['git push origin main', 'git push origin "main"', "git push origin 'master'", 'git push origin HEAD:main', 'git push --force origin main', 'git push origin \\\n main', 'git push --all origin', 'git push --mirror', 'BR=main; git push origin $BR', 'git -C /x push origin main', 'git reset --hard origin/main', 'git checkout main', 'git switch master', 'git checkout -B main origin/x', 'git branch -D main', 'git branch -M main', 'git fetch origin main:main', 'git merge main', 'git pull origin main', 'git cherry-pick abc && git push origin main', 'git update-ref refs/heads/main abc'])
      expect(f(c).mainBranch, c).toBe(true);
  });
  it('starting from main, looking at it, naming it in a message are not actions on it', () => {
    for (const c of ['git checkout -b feature origin/main', 'git switch -c feature main', 'git branch feature main', 'git checkout origin/main -- package.json', 'git diff origin/main', 'git log main..HEAD', 'git merge-base main HEAD', 'git fetch origin main', 'git commit -m "update main page"', 'git rebase origin/develop', 'git push origin feature/x', 'git push origin HEAD', 'echo "git push origin main"'])
      expect(f(c).mainBranch, c).toBe(false);
  });
});

describe('what a command writes, moves or deletes', () => {
  it('the usual writers', () => {
    expect(paths('rm -rf /etc/nginx dist')).toEqual(['/etc/nginx', 'dist']);
    expect(paths('echo hi > /var/www/index.html')).toEqual(['/var/www/index.html']);
    expect(paths('cmd >> log.txt 2> /tmp/err')).toEqual(['log.txt', '/tmp/err']);
    expect(paths('cp a.txt b.txt /opt/x')).toEqual(['/opt/x']);
    expect(paths('cp -t /opt/dir a b')).toEqual(['/opt/dir']);
    expect(paths('mv /etc/hosts ./hosts.bak')).toEqual(['/etc/hosts', './hosts.bak']);
    expect(paths('ln -s /usr/bin/python3 ./py')).toEqual(['./py']);
    expect(paths('tee /etc/x a.log')).toEqual(['/etc/x', 'a.log']);
    expect(paths('sed -i s/a/b/ /etc/hosts')).toEqual(['/etc/hosts']);
    expect(paths('sed --in-place s/a/b/ /etc/hosts')).toEqual(['/etc/hosts']);
    expect(paths('find /home/user -name "*.bak" -delete')).toEqual(['/home/user']);
    expect(paths('curl -o /usr/local/bin/foo https://x.io/f')).toEqual(['/usr/local/bin/foo']);
    expect(paths('wget -O /usr/local/bin/foo https://x.io/f')).toEqual(['/usr/local/bin/foo']);
    expect(paths('tar -C /opt -xf a.tgz')).toEqual(['/opt']);
    expect(paths('dd if=a of=/dev/sdb')).toEqual(['/dev/sdb']);
    expect(paths('git clone https://x.io/r.git /srv/r')).toEqual(['/srv/r']);
    expect(paths('chmod 755 /usr/local/bin/foo')).toEqual(['/usr/local/bin/foo']);
  });
  it('through wrappers, shells and substitutions', () => {
    expect(paths('sudo rm -rf /etc/x')).toEqual(['/etc/x']);
    expect(paths('env A=1 rm -rf /etc/x')).toEqual(['/etc/x']);
    expect(paths(`bash -c "rm -rf /etc/nginx"`)).toEqual(['/etc/nginx']);
    expect(paths(`sh -c 'cd /srv && rm -rf app'`)).toEqual(['app']);
    expect(f(`sh -c 'cd /srv && rm -rf app'`).mutated[0]!.cwd).toBe('/srv');
    expect(paths('echo $(rm -rf /etc/x)')).toEqual(['/etc/x']);
    expect(paths('nohup rm -rf /etc/x &')).toEqual(['/etc/x']);
    expect(paths(`node -e "require('fs').writeFileSync('/etc/x','y')"`)).toEqual(['/etc/x']);
    expect(paths(`python3 -c "open('/etc/x','w').write('y')"`)).toEqual(['/etc/x']);
  });
  it('what only reads writes nothing', () => {
    for (const c of ['cat /etc/hosts', 'ls /usr/local', 'cp /etc/hosts ./hosts.bak', 'cat /etc/hosts > ./hosts.copy', 'grep -r x /var/log', 'echo x > /dev/null', 'ls 2>&1', 'node build.js', `python3 -c "print(open('/etc/hosts').read())"`])
      expect(paths(c).filter((p) => p.startsWith('/') && !p.startsWith('/dev')), c).toEqual([]);
  });
  it('a path that cannot be known is flagged dynamic; cd into the unknown loses the directory', () => {
    expect(f('rm -rf $HOME/old').mutated[0]).toMatchObject({ path: '$HOME/old', dynamic: true });
    expect(f('rm -rf ~/old').mutated[0]).toMatchObject({ dynamic: true });
    expect(f('cd $SOMEWHERE && rm -rf old').mutated[0]).toMatchObject({ path: 'old', cwd: null });
    expect(f('cd .. && rm -rf old').mutated[0]).toMatchObject({ cwd: '/work' });
  });
  it('heredoc bodies are text, not commands', () => {
    expect(paths('cat > run.sh <<EOF\nrm -rf /etc\nEOF')).toEqual(['run.sh']);
  });
});
