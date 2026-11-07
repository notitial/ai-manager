import test from 'node:test'
import assert from 'node:assert/strict'
import * as p from './prompts.ts'

const H = 'a'.repeat(64)
const SID_A = '0a1b2c3d-0000-4000-8000-123456789abc'
const SID_B = '1a1b2c3d-0000-4000-8000-123456789abc'
const ID = '2a1b2c3d-0000-4000-8000-123456789abc'
const GIT = 'mcp__git-mcp__'
const floor = (tool: string, input: unknown, o: p.FloorOpts = {}) => p.floorCheck(tool, input, o)
const HOME = { home: '/Users/x' }

// ---- the floor: each row, allow and refuse, with the bypass spellings ----
test('floor: merges on any server, branch updates, and the optional merge item by its own tool name only', () => {
  assert.equal(floor('mcp__github__merge_pull_request', {}), 'merge')
  assert.equal(floor('mcp__other__merge_pull_request', {}), 'merge')
  assert.equal(floor('mcp__github__update_pull_request_branch', {}), 'merge')
  assert.equal(floor('mcp__machine-ops__pr_merge', {}), 'merge')
  assert.equal(floor('mcp__machine-ops__pr_merge', {}, { optional: { merges: true } }), undefined)
  // The optional merge item lifts nothing else: every other merge shape stays floor.
  assert.equal(floor('mcp__github__merge_pull_request', {}, { optional: { merges: true } }), 'merge')
  assert.equal(floor('Bash', { command: 'gh pr merge 5 --squash' }, { optional: { merges: true } }), 'merge')
  assert.equal(floor('mcp__github__get_file_contents', {}), undefined)
})
test('floor: git_merge only on main, master or production (unresolved is floor); every Bash merge is floor', () => {
  assert.equal(floor(`${GIT}git_merge`, { path: '/r' }, { branch: 'main' }), 'merge')
  assert.equal(floor(`${GIT}git_merge`, { path: '/r' }, { branch: 'production' }), 'merge')
  assert.equal(floor(`${GIT}git_merge`, { path: '/r' }, {}), 'merge')
  assert.equal(floor(`${GIT}git_merge`, { path: '/r' }, { branch: 'feat/x' }), undefined)
  // Bash: the branch a merge lands on depends on a cd, -C or checkout in the same line, so no spelling is judged by the branch.
  for (const command of ['git merge origin/main', 'git checkout main && git merge feat/x', 'git -C /other merge x', 'cd /other && git merge x', 'git -c a=b merge x', 'git \\\nmerge x'])
    for (const branch of ['master', 'feat/x', undefined]) assert.equal(floor('Bash', { command }, { branch }), 'merge', `${command} on ${branch}`)
  for (const command of ['gh pr merge 5', 'gh -R o/r pr merge 5', 'gh --repo o/r pr merge 5 --squash', 'gh api -X PUT repos/o/r/pulls/5/merge', 'gh api repos/o/r/pulls/5/merge -X PUT'])
    assert.equal(floor('Bash', { command }), 'merge', command)
  assert.equal(floor('Bash', { command: 'gh pr view 5' }), undefined)
})
test('floor: the GitHub server writes to a branch, and its deletes', () => {
  for (const name of ['push_files', 'create_or_update_file']) {
    for (const branch of ['main', 'refs/heads/main', 'MASTER', 'origin/production', undefined, 7]) assert.equal(floor(`mcp__github__${name}`, { branch }), 'protected-push', `${name} ${branch}`)
    assert.equal(floor(`mcp__github__${name}`, { branch: 'feat/x' }), undefined, name)
  }
  for (const name of ['delete_file', 'delete_branch', 'delete_ref', 'delete_tag', 'delete_repository']) assert.equal(floor(`mcp__github__${name}`, { branch: 'feat/x' }), 'destructive', name)
  assert.equal(floor('mcp__github__get_file_contents', { branch: 'main' }), undefined)
})
test('floor: git_push shapes that read as the current branch, a delete, an option or a matching push', () => {
  // An empty ref is no ref: the current branch is read (unresolved is floor).
  assert.equal(floor(`${GIT}git_push`, { path: '/r', branch: '' }, {}), 'protected-push')
  assert.equal(floor(`${GIT}git_push`, { path: '/r', branch: '' }, { branch: 'main' }), 'protected-push')
  assert.equal(floor(`${GIT}git_push`, { path: '/r', branch: '  ' }, { branch: 'feat/x' }), undefined)
  assert.equal(p.needsBranch(`${GIT}git_push`, { path: '/r', branch: '' }), true)
  assert.equal(floor(`${GIT}git_push`, { path: '/r', branch: ':' }, { branch: 'feat/x' }), 'protected-push')
  assert.equal(floor(`${GIT}git_push`, { path: '/r', branch: ':feat/x' }), 'destructive')
  assert.equal(floor(`${GIT}git_push`, { path: '/r', branch: 'origin :feat' }), 'protected-push')
  // A glob, a remote that reads as an option, and force or delete given as anything but false.
  for (const branch of ['refs/heads/*:refs/heads/*', '*:*', 'feat/x main', 'feat/ma?n']) assert.equal(floor(`${GIT}git_push`, { path: '/r', branch }), 'protected-push', branch)
  for (const remote of ['--all', '--mirror', 'a b', 7]) assert.equal(floor(`${GIT}git_push`, { path: '/r', remote, branch: 'feat/x' }), 'protected-push', String(remote))
  assert.equal(floor(`${GIT}git_push`, { path: '/r', force: 'true', branch: 'feat/x' }), 'force-push')
  assert.equal(floor(`${GIT}git_push`, { path: '/r', force: false, branch: 'feat/x' }), undefined)
  assert.equal(floor(`${GIT}git_push`, { path: '/r', delete: 1, branch: 'feat/x' }), 'destructive')
  assert.equal(floor(`${GIT}git_push`, { path: '/r', remoteBranch: 'heads/main' }), 'protected-push')
  for (const branch of ['--force', '--mirror', '--all', '-d']) assert.equal(floor(`${GIT}git_push`, { path: '/r', branch }), 'protected-push', branch)
  for (const branch of [7, ['main'], { a: 1 }, true]) assert.equal(floor(`${GIT}git_push`, { path: '/r', branch }), 'protected-push', JSON.stringify(branch))
})
test('floor: force pushes by flag, by + refspec, and the optional force item by its own tool name only', () => {
  assert.equal(floor(`${GIT}git_push`, { branch: 'feat/x', force: true }), 'force-push')
  assert.equal(floor(`${GIT}git_push`, { branch: 'feat/x', forceWithLease: true }), 'force-push')
  assert.equal(floor(`${GIT}git_push`, { branch: '+feat/x' }), 'force-push')
  assert.equal(floor('Bash', { command: 'git push --force origin feat/x' }), 'force-push')
  assert.equal(floor('Bash', { command: 'git push --force-with-lease origin feat/x' }), 'force-push')
  assert.equal(floor('Bash', { command: 'git push -f origin feat/x' }), 'force-push')
  assert.equal(floor('Bash', { command: 'git push origin +feat/x' }), 'force-push')
  assert.equal(floor('mcp__machine-ops__force_push', {}), 'force-push')
  assert.equal(floor('mcp__machine-ops__force_push', {}, { optional: { forcePushes: true } }), undefined)
  assert.equal(floor(`${GIT}git_push`, { branch: 'feat/x', force: true }, { optional: { forcePushes: true } }), 'force-push')
})
test('floor: a push to a protected branch, in every spelling, and any Bash git push', () => {
  for (const b of ['main', 'master', 'production', 'refs/heads/main', 'origin/main', 'MAIN', 'upstream/master', 'refs/remotes/origin/production']) {
    assert.equal(floor(`${GIT}git_push`, { path: '/r', branch: b }), 'protected-push', b)
    assert.equal(floor(`${GIT}git_push`, { path: '/r', branch: 'feat/x', remoteBranch: b }), 'protected-push', `remote ${b}`)
  }
  assert.equal(floor(`${GIT}git_push`, { path: '/r', branch: '+main' }), 'force-push')
  assert.equal(floor(`${GIT}git_push`, { path: '/r', branch: 'HEAD:main' }), 'protected-push')
  assert.equal(floor(`${GIT}git_push`, { path: '/r', branch: 'feat/x:refs/heads/main' }), 'protected-push')
  // The current branch: '@', HEAD and no branch at all are read; unresolved is floor.
  assert.equal(floor(`${GIT}git_push`, { path: '/r', branch: '@' }, { branch: 'main' }), 'protected-push')
  assert.equal(floor(`${GIT}git_push`, { path: '/r', branch: '@' }, {}), 'protected-push')
  assert.equal(floor(`${GIT}git_push`, { path: '/r' }, { branch: 'feat/x' }), undefined)
  assert.equal(floor(`${GIT}git_push`, { path: '/r' }, { branch: 'master' }), 'protected-push')
  assert.equal(floor(`${GIT}git_push`, { path: '/r' }, {}), 'protected-push')
  assert.equal(floor(`${GIT}git_push`, { path: '/r', branch: 'feat/main-menu' }), undefined)
  assert.equal(floor(`${GIT}git_push`, { path: '/r', branch: 'feat/x', remote: 'origin' }), undefined)
  assert.equal(floor('Bash', { command: 'git push origin feat/x' }), 'protected-push')
  assert.equal(floor('Bash', { command: 'cd /r && git push' }), 'protected-push')
})
test('floor: destructive git shapes and Bash deletes', () => {
  assert.equal(floor(`${GIT}git_push`, { branch: 'feat/x', delete: true }), 'destructive')
  assert.equal(floor(`${GIT}git_clean`, {}), 'destructive')
  for (const mode of ['hard', 'merge', 'keep']) assert.equal(floor(`${GIT}git_reset`, { mode }), 'destructive')
  assert.equal(floor(`${GIT}git_reset`, { mode: 'soft' }), undefined)
  assert.equal(floor(`${GIT}git_branch`, { mode: 'delete', branchName: 'x' }), 'destructive')
  assert.equal(floor(`${GIT}git_branch`, { mode: 'create', force: true }), 'destructive')
  assert.equal(floor(`${GIT}git_branch`, { mode: 'list' }), undefined)
  assert.equal(floor(`${GIT}git_stash`, { mode: 'drop' }), 'destructive')
  assert.equal(floor(`${GIT}git_stash`, { mode: 'clear' }), 'destructive')
  assert.equal(floor(`${GIT}git_stash`, { mode: 'list' }), undefined)
  assert.equal(floor(`${GIT}git_tag`, { mode: 'delete' }), 'destructive')
  assert.equal(floor(`${GIT}git_checkout`, { target: 'x', force: true }), 'destructive')
  assert.equal(floor(`${GIT}git_checkout`, { target: 'x', paths: ['a'] }), 'destructive')
  assert.equal(floor(`${GIT}git_checkout`, { target: 'x' }), undefined)
  for (const command of ['rm -rf build', 'ls && rm x', 'find . -name a -delete', 'truncate -s 0 f', 'dd if=/dev/zero of=/dev/disk2', 'mkfs.ext4 /dev/x', 'git branch -D x', 'git branch --delete x', 'git clean -fd', 'git reset --hard HEAD~1', 'git stash drop', 'git tag -d v1',
    '/bin/rm -rf x', '/usr/bin/rm x', '\\rm -rf x', 'echo a;/bin/rm x', 'git -C /r clean -fdx', 'git -C /r reset --hard', 'git -c a=b branch -D x', 'git -C /r stash drop', 'git -C /r tag -d v1', 'git \\\nclean -fd'])
    assert.equal(floor('Bash', { command }), 'destructive', command)
  assert.equal(floor('Bash', { command: 'git \\\npush origin x' }), 'protected-push')
  for (const command of ['ls -la', 'echo remove', 'git status', 'grep -rn format src', 'git log --oneline']) assert.equal(floor('Bash', { command }), undefined, command)
})
test('floor: SQL in any tool\'s string input', () => {
  assert.equal(floor('mcp__db__query', { sql: 'DROP TABLE users' }), 'destructive')
  assert.equal(floor('mcp__db__query', { sql: 'drop database x' }), 'destructive')
  assert.equal(floor('mcp__db__query', { sql: 'TRUNCATE TABLE users' }), 'destructive')
  assert.equal(floor('mcp__db__query', { sql: 'truncate users' }), 'destructive')
  assert.equal(floor('mcp__db__query', { sql: 'delete   from users where 1=1' }), 'destructive')
  assert.equal(floor('mcp__db__query', { nested: { q: ['select 1', 'DELETE FROM t'] } }), 'destructive')
  for (const sql of ['DELETE t FROM t JOIN u ON 1=1', 'DELETE LOW_PRIORITY FROM t', 'DELETE/**/FROM t', 'delete /* x */ from t', 'DROP/**/TABLE t', 'TRUNCATE/**/x', 'DELETE t1, t2 FROM t1 JOIN t2', 'DELETE t1.* FROM t1', 'DELETE -- c\nFROM t']) assert.equal(floor('mcp__db__query', { sql }), 'destructive', sql)
  // Past the depth cap the rest is read whole, so nesting cannot hide it.
  let deep: any = { sql: 'DROP TABLE users' }
  for (let i = 0; i < 20; i++) deep = { a: deep }
  assert.equal(floor('mcp__db__query', deep), 'destructive')
  assert.equal(floor('mcp__db__query', { sql: 'select count(*) from users' }), undefined)
  // A run of comment openers cannot stall the scan, and a string too long to scan is floor.
  const t0 = Date.now()
  floor('mcp__db__query', { sql: 'DELETE' + ' /**/'.repeat(5000) + ' x' })
  floor('mcp__db__query', { sql: 'DELETE ' + '/* '.repeat(60_000) })
  assert.ok(Date.now() - t0 < 2000)
  assert.equal(floor('mcp__db__query', { sql: 'x'.repeat(200_001) }), 'destructive')
  assert.equal(floor('mcp__db__query', { sql: 'select * from drop_events' }), undefined)
})
test('floor: settings, hooks and callboard state, by path (written and real) and by shell text', () => {
  for (const file_path of ['/Users/x/.claude/settings.json', '~/.claude/callboard/prompts/ledger-2026-11.jsonl', '/Users/x/.claude/hooks/a.sh', '/r/.claude/settings.local.json', '/r/.mcp.json', '/r/.git/hooks/pre-commit', '/r/install.conf', '/r/a/../.mcp.json', '/Users/x/.claude',
    '/r/.MCP.json', '/r/.claude/Settings.local.json', '/R/.GIT/hooks/x', '/r/.git/config', '/Users/x/.gitconfig', '/r/.claude/hooks/a.sh', '/r/.husky/pre-commit', '/r/.githooks/x', '/r/.git/modules/s/hooks/post-checkout', '/r/.git/config.worktree', '/r/.git/worktrees/w/config.worktree', '/USERS/X/.CLAUDE/rules/a.md'])
    assert.equal(floor('Write', { file_path }, HOME), 'settings', file_path)
  assert.equal(floor('Edit', { file_path: '/r/src/a.ts' }, { ...HOME, roots: ['/live/ai-manager'] }), undefined)
  assert.equal(floor('Edit', { file_path: '/live/ai-manager/docs/a.md' }, { ...HOME, roots: ['/live/ai-manager'] }), 'settings')
  assert.equal(floor('Edit', { file_path: '/LIVE/AI-Manager/docs/a.md' }, { ...HOME, roots: ['/live/ai-manager'] }), 'settings')
  assert.equal(floor('Bash', { command: 'vi /live/toolkit/hooks/x.sh' }, { ...HOME, roots: ['/live/ai-manager', '/live/toolkit'] }), 'settings')
  assert.equal(floor('Bash', { command: 'git config user.name' }, HOME), undefined)
  // A link: the written path is harmless, its real path is not.
  assert.equal(floor('Write', { file_path: '/r/link.json' }, { ...HOME, real: ['/Users/x/.claude/settings.json'] }), 'settings')
  assert.equal(floor('Write', { file_path: '/r/link.json' }, { ...HOME, real: ['/r/link.json'] }), undefined)
  for (const command of ['cat ~/.claude/settings.json', 'echo x > $HOME/.claude/rules/a.md', 'ls /Users/x/.claude/callboard', 'cp a .claude/settings.local.json', 'cat .mcp.json', 'claude mcp add x', 'CLAUDE_CODE_PLUGIN_DIRS=/x claude', 'x/workspace-lock.sh --id a clear', 'cat install.conf', 'git config core.hooksPath /tmp/h', 'git -C /r config --local core.fsmonitor /x', 'git config alias.x !sh', 'echo a >> .git/config', 'cat ~/.gitconfig', 'cat /r/.husky/x'])
    assert.equal(floor('Bash', { command }, HOME), 'settings', command)
  assert.equal(floor('Bash', { command: 'ls /Users/x/code' }, HOME), undefined)
})
test('floor: ExitPlanMode is a dialog', () => {
  assert.equal(floor('ExitPlanMode', {}), 'dialog')
})
test('floor: needsBranch and gitPathOf', () => {
  assert.equal(p.needsBranch(`${GIT}git_push`, { path: '/r' }), true)
  assert.equal(p.needsBranch(`${GIT}git_push`, { path: '/r', branch: 'feat/x' }), false)
  assert.equal(p.needsBranch(`${GIT}git_push`, { path: '/r', branch: '@' }), true)
  assert.equal(p.needsBranch(`${GIT}git_merge`, { path: '/r' }), true)
  // A Bash merge or push is floor whatever the branch, so none is read.
  assert.equal(p.needsBranch('Bash', { command: 'git merge x' }), false)
  assert.equal(p.needsBranch('Read', {}), false)
  assert.equal(p.gitPathOf(`${GIT}git_push`, { path: '/r' }), '/r')
  assert.equal(p.gitPathOf(`${GIT}git_push`, { path: './r' }), undefined)
  assert.equal(p.gitPathOf('Bash', { path: '/r' }), undefined)
})

// ---- the classifier table from the probes ----
test('classify: rule, hook, rule+hook, guard, imitator, setting, plugin, ceiling, mode', () => {
  const ask = { decision: 'ask' }
  assert.deepEqual(p.classify('Bash', { ...ask, rule: 'Bash(ssh:*)' }), { judge: 'agents', raisedBy: 'rule' })
  assert.deepEqual(p.classify('Bash', ask), { judge: 'agents', raisedBy: 'mode' })
  assert.deepEqual(p.classify('Bash', { ...ask, reason: 'because' }), { judge: 'agents', raisedBy: 'mode' })
  const guard = { ...ask, hook: 'PreToolUse', reason: `${p.GUARD_PREFIX}comment on a PR` }
  for (const t of p.GUARD_TOOLS) assert.deepEqual(p.classify(t, guard), { judge: 'agents', raisedBy: 'guard' }, t)
  // The same prefix on another tool, or on a rule-covered tool, or a guard of another name, stays his.
  assert.equal(p.classify('Bash', guard).judge, 'person')
  assert.equal(p.classify('mcp__github__actions_run_trigger', guard).judge, 'person')
  assert.equal(p.classify('mcp__github__create_pull_request', { ...guard, rule: 'mcp__github__create_pull_request' }).judge, 'person')
  assert.equal(p.classify('mcp__github__create_pull_request', { ...ask, hook: 'PreToolUse', reason: 'other-guard: x' }).judge, 'person')
  assert.equal(p.classify('mcp__github__create_pull_request', { ...ask, hook: 'PreToolUse' }).judge, 'person')
  assert.equal(p.classify('mcp__github__create_pull_request', { ...guard, hook: 'PostToolUse' }).judge, 'person')
  // Any other hook ask, with or without a rule, is his.
  assert.equal(p.classify('Bash', { ...ask, hook: 'PreToolUse', reason: 'x' }).judge, 'person')
  assert.equal(p.classify('Bash', { ...ask, hook: 'PreToolUse', rule: 'Bash(rm:*)', reason: 'x' }).judge, 'person')
  assert.equal(p.classify('Bash', { ...ask, setting: 'permissions.x' }).judge, 'person')
  assert.equal(p.classify('Bash', { ...ask, plugin: 'other' }).judge, 'person')
  assert.equal(p.classify('Bash', { ...ask, ceiling: 'ask' }).judge, 'person')
  assert.equal(p.classify('Bash', { ...guard, plugin: 'other' }).judge, 'person')
  // A question stays his until PR 4, and only an ask is ever judged.
  assert.equal(p.classify('AskUserQuestion', ask).judge, 'person')
  assert.equal(p.classify('Bash', { decision: 'allow' }).judge, 'person')
  assert.equal(p.classify('Bash', {}).judge, 'person')
})

test('classify: marking a PR ready (update_pull_request, draft false) is the guard row: agents judge it, it is not floor and not his', () => {
  // The reason as ai-toolkit's tools/github-mcp/guard.sh builds it for draft false (read from the script, not run).
  const reason = `${p.GUARD_PREFIX}update_pull_request on "o"/"r" #12 sets draft false; nothing else. Setting draft to false marks the PR ready for review, which starts the automatic paid Claude review. The title and body are shown to everyone on the PR and read by its automatic reviewer.`
  const input = { owner: 'o', repo: 'r', pullNumber: 12, draft: false }
  assert.deepEqual(p.classify('mcp__github__update_pull_request', { decision: 'ask', hook: 'PreToolUse', reason }), { judge: 'agents', raisedBy: 'guard' })
  assert.equal(floor('mcp__github__update_pull_request', input), undefined)
  // The branch update next to it is a merge shape and stays floor.
  assert.equal(floor('mcp__github__update_pull_request_branch', { owner: 'o', repo: 'r', pullNumber: 12 }), 'merge')
  // With an ask rule on the tool, core's reason hides the guard's, so it stays his.
  assert.equal(p.classify('mcp__github__update_pull_request', { decision: 'ask', hook: 'PreToolUse', rule: 'mcp__github__update_pull_request', reason: 'rule' }).judge, 'person')
  assert.equal(p.patternOf('mcp__github__update_pull_request', input), 'mcp__github__update_pull_request o/r #12')
})

// ---- redaction vectors and caps. The vectors are built from pieces so no literal in this file looks like a real key. ----
const j = (...parts: string[]) => parts.join('')
test('redact: the vectors of audit-logger.sh', () => {
  const v: [string, string][] = [
    [j('key AK', 'IAABCDEFGH1234 end'), 'key [REDACTED_AWSKEY] end'],
    [j('gh', 'p_abcDEF123'), '[REDACTED_GHTOKEN]'],
    [j('github', '_pat_ab_12'), '[REDACTED_GHTOKEN]'],
    [j('gl', 'pat-ab-12'), '[REDACTED_GLPAT]'],
    [j('s', 'k-ant-abc_123'), '[REDACTED_APIKEY]'],
    [j('s', 'k_live_abc123'), '[REDACTED_STRIPE]'],
    [j('xo', 'xb-12-ab'), '[REDACTED_SLACK]'],
    [j('AI', 'za', 'Sy_abc-1'), '[REDACTED_GOOGLE]'],
    [j('ey', 'Jhbgcioi.', 'ey', 'Jzdwiioi.abc_DEF-1'), '[REDACTED_JWT]'],
    [j('post', 'gres://user:pw123@db/x'), j('post', 'gres://user:[REDACTED]@db/x')],
    [j('Authorization: Bear', 'er abc.def-1'), j('Authorization: Bear', 'er [REDACTED]')],
    [j('pass', 'word=hunter2 next'), j('pass', 'word=[REDACTED] next')],
    [j('"api', '_key": "abc123"'), j('"api', '_key": "[REDACTED]"')],
    [j('-----BEGIN RSA PRIVATE', ' KEY-----\nabc\n-----END RSA PRIVATE', ' KEY-----'), '[REDACTED_PEM]'],
    [j('NR', 'AK-ABC123'), '[REDACTED_NRKEY]'],
  ]
  for (const [a, b] of v) assert.equal(p.redact(a), b, a)
  assert.equal(p.redact('plain text, no secret'), 'plain text, no secret')
  assert.equal(p.redact('a risk-free task'), 'a risk-free task')
})
test('capInput: strings redacted and capped, the whole kept under the cap, truncated says so', () => {
  const small = p.capInput({ command: 'ls', n: 1, ok: true, list: ['a'], deep: { x: null } })
  assert.deepEqual(small, { input: { command: 'ls', n: 1, ok: true, list: ['a'], deep: { x: null } }, truncated: false })
  const secret = p.capInput({ command: j('curl -H "Authorization: Bear', 'er abc123"') })
  assert.match(JSON.stringify(secret.input), /\[REDACTED\]/)
  assert.doesNotMatch(JSON.stringify(secret.input), /abc123/)
  const long = p.capInput({ s: 'x'.repeat(5000) })
  assert.equal(long.truncated, true)
  assert.ok(new TextEncoder().encode((long.input as any).s).length <= p.STRING_CAP)
  const wide = p.capInput({ list: Array.from({ length: 150 }, (_, i) => `${'y'.repeat(1900)}${i}`) })
  assert.equal(wide.truncated, true)
  assert.ok(new TextEncoder().encode(JSON.stringify(wide.input)).length <= p.INPUT_CAP)
  assert.equal(p.capInput({ f: () => 1 } as any).truncated, true)
  // A cut never lands inside a character.
  assert.ok(!p.capBytes('é'.repeat(20), 5).text.includes('�'))
})
test('capInput: a value under a key that names a secret is replaced, whatever it looks like', () => {
  const k = (...a: string[]) => a.join('')
  const r = p.capInput({ [k('pass', 'word')]: 'hunter2', env: { [k('API', '_KEY')]: 'abc', PATH: '/bin', max_tokens: '4000', [k('PG', 'PASSWORD')]: 'p1', [k('access', 'Token')]: 't1', [k('client', 'Secret')]: 's1', [k('db', 'Pass', 'word')]: 'p2' }, headers: { [k('Cook', 'ie')]: 'sid=1', Accept: 'x' }, list: [{ [k('to', 'ken')]: 'zzz', name: 'n' }], [k('Author', 'ization')]: ['a', 'b'] }).input as any
  assert.equal(r[k('pass', 'word')], '[REDACTED]')
  assert.equal(r.env[k('API', '_KEY')], '[REDACTED]')
  assert.equal(r.env.PATH, '/bin')
  assert.equal(r.env.max_tokens, '4000')
  for (const key of ['PG' + 'PASSWORD', 'access' + 'Token', 'client' + 'Secret', 'db' + 'Pass' + 'word']) assert.equal(r.env[key], '[REDACTED]', key)
  assert.equal(r.headers[k('Cook', 'ie')], '[REDACTED]')
  assert.equal(r.headers.Accept, 'x')
  assert.equal(r.list[0][k('to', 'ken')], '[REDACTED]')
  assert.equal(r.list[0].name, 'n')
  assert.deepEqual(r[k('Author', 'ization')], ['[REDACTED]', '[REDACTED]'])
  // A path, a pattern and an author are not secrets.
  assert.deepEqual(p.capInput({ file_path: '/r/a', pattern: 'x', author: 'me' }).input, { file_path: '/r/a', pattern: 'x', author: 'me' })
})
test('redact: option forms, userinfo of any scheme, and basic credentials', () => {
  const k = (...a: string[]) => a.join('')
  assert.equal(p.redact(k('tool --pass', 'word hunter2 --x 1')), k('tool --pass', 'word [REDACTED] --x 1'))
  assert.equal(p.redact(k('tool --to', 'ken abc123')), k('tool --to', 'ken [REDACTED]'))
  assert.equal(p.redact(k('my', 'sql -u root -pSEC', 'RET db')), k('my', 'sql -u root -p[REDACTED] db'))
  assert.equal(p.redact('mkdir -p out'), 'mkdir -p out')
  assert.equal(p.redact(k('https://user:pa', 'ss@host/x')), k('https://user:[REDACTED]@host/x'))
  assert.equal(p.redact(k('git+ssh://u:p', 'w@h/x')), k('git+ssh://u:[REDACTED]@h/x'))
  assert.equal(p.redact(k('Authorization: Ba', 'sic dXNlcjpwYXNz')), k('Authorization: Ba', 'sic [REDACTED]'))
  assert.equal(p.redact('https://example.com/a:b'), 'https://example.com/a:b')
})
test('canonical: key order does not change it, and the join key names tool, hash and agent', () => {
  assert.equal(p.canonical({ b: 1, a: { d: 2, c: [3, { y: 1, x: 2 }] } }), p.canonical({ a: { c: [3, { x: 2, y: 1 }], d: 2 }, b: 1 }))
  assert.notEqual(p.canonical({ a: 1 }), p.canonical({ a: 2 }))
  assert.notEqual(p.joinKey('Bash', H, undefined), p.joinKey('Bash', H, 'agent1'))
})

// ---- the awake clock, expiry, windows ----
test('awake clock: a gap is capped, a clock that ran back adds nothing, a sleep gap cannot age a prompt', () => {
  assert.equal(p.awakeAdd(0, 2000), 2000)
  assert.equal(p.awakeAdd(5000, 3_600_000), 15_000)
  assert.equal(p.awakeAdd(5000, -50), 5000)
  assert.equal(p.awakeAdd(5000, Number.NaN), 5000)
  assert.equal(p.expiresAfter(false), 21 * 60_000)
  assert.equal(p.expiresAfter(true), 2 * 3_600_000)
  assert.equal(p.pollFor(true), 10_000)
})

// ---- apply: each code ----
const baseReq = { id: ID, nonce: 'n1', inputHash: H, sid: SID_A }
const baseDec = (o: Partial<p.Decision> = {}): p.Decision => ({ id: ID, inputHash: H, decision: 'allow', why: 'ok', by: { level: 'lead', sid: SID_B, name: 'LEAD' }, at: 1, nonce: 'n1', ...o })
const apply = (o: Partial<p.ApplyIn> = {}): p.ApplyOut => p.applyCheck({ req: baseReq, decision: baseDec(), liveHash: H, awakeMs: 60_000, expiresAt: p.EXPIRES_MS, floor: undefined, byOk: true, ledger: 'found', graceMs: 0, ...o })
test('apply: a good decision applies', () => {
  assert.deepEqual(apply(), { ok: true })
})
test('apply: each refusal has its code', () => {
  assert.deepEqual(apply({ decision: baseDec({ id: SID_B }) }), { drop: 'id' })
  assert.deepEqual(apply({ liveHash: 'b'.repeat(64) }), { drop: 'hash' })
  assert.deepEqual(apply({ decision: baseDec({ inputHash: 'b'.repeat(64) }) }), { drop: 'hash' })
  assert.deepEqual(apply({ decision: baseDec({ nonce: 'other' }) }), { drop: 'nonce' })
  assert.deepEqual(apply({ awakeMs: p.EXPIRES_MS }), { drop: 'expired' })
  assert.deepEqual(apply({ floor: 'merge' }), { drop: 'floor' })
  assert.deepEqual(apply({ byOk: false }), { drop: 'by-sid' })
  assert.deepEqual(apply({ decision: baseDec({ by: { level: 'lead', sid: SID_A, name: 'A' } }) }), { drop: 'by-sid' })
  assert.deepEqual(apply({ decision: baseDec({ by: { level: 'lead', sid: 'not-a-sid', name: 'A' } }) }), { drop: 'by-sid' })
  assert.deepEqual(apply({ decision: baseDec({ by: { level: 'manager', sid: SID_B, name: 'M' } }) }), { drop: 'by-sid' })
  assert.deepEqual(apply({ ledger: 'unreadable' }), { drop: 'ledger-unreadable' })
  assert.deepEqual(apply({ ledger: 'missing', graceMs: p.LEDGER_GRACE_MS }), { drop: 'no-answered-row' })
})
test('apply: early and a row that lags are held, not dropped; a refusal outranks a hold', () => {
  assert.deepEqual(apply({ awakeMs: p.MIN_AGE_MS - 1 }), { hold: 'early' })
  assert.deepEqual(apply({ awakeMs: p.MIN_AGE_MS }), { ok: true })
  assert.deepEqual(apply({ ledger: 'missing', graceMs: p.LEDGER_GRACE_MS - 1 }), { hold: 'ledger' })
  assert.deepEqual(apply({ awakeMs: 1000, floor: 'destructive' }), { drop: 'floor' })
  assert.deepEqual(apply({ awakeMs: 1000, decision: baseDec({ nonce: 'x' }) }), { drop: 'nonce' })
})
test('parseDecision: only the exact shape, no answer decision yet, and a size cap', () => {
  const good = JSON.stringify(baseDec())
  assert.deepEqual(p.parseDecision(good), { ...baseDec(), via: undefined })
  assert.equal(p.parseDecision('{'), undefined)
  assert.equal(p.parseDecision('[]'), undefined)
  assert.equal(p.parseDecision(JSON.stringify({ ...baseDec(), decision: 'answer', answer: 'x' })), undefined)
  assert.equal(p.parseDecision(JSON.stringify({ ...baseDec(), via: 'manager' })), undefined)
  assert.equal(p.parseDecision(JSON.stringify({ ...baseDec(), by: { level: 'lead', sid: 1, name: 'x' } })), undefined)
  assert.equal(p.parseDecision(JSON.stringify({ ...baseDec(), why: 'x'.repeat(5000) })), undefined)
})

// ---- ledger rows ----
test('ledgerLine: one line, redacted and capped why, whole under the row cap, no input text', () => {
  const line = p.ledgerLine({ t: '2026-11-07T00:00:00.000Z', kind: 'requested', id: ID, tool: 'Bash', pattern: 'ls', hash: H, why: j('Bear', 'er abc123\nsecond ', 'x'.repeat(500)) })
  assert.ok(line.endsWith('\n') && line.indexOf('\n') === line.length - 1)
  const row = JSON.parse(line)
  assert.doesNotMatch(row.why, /abc123/)
  assert.ok(new TextEncoder().encode(row.why).length <= p.WHY_MAX)
  const big = p.ledgerLine({ t: 't', kind: 'dropped', code: 'hash', id: ID, repo: 'r'.repeat(100_000), why: 'w'.repeat(100_000) })
  assert.ok(new TextEncoder().encode(big).length < p.LEDGER_ROW_MAX)
  assert.equal(p.ledgerFile(Date.UTC(2026, 10, 7)), 'ledger-2026-11.jsonl')
  assert.equal(p.ledgerFilePrev(Date.UTC(2026, 10, 7)), 'ledger-2026-10.jsonl')
  assert.equal(p.ledgerFilePrev(Date.UTC(2026, 0, 2)), 'ledger-2025-12.jsonl')
})
test('patternOf: argv0 only, owner/repo and number for GitHub, a repo-relative path for files', () => {
  assert.equal(p.patternOf('Bash', { command: '/usr/bin/ssh host rm -rf x' }), 'ssh')
  assert.equal(p.patternOf('mcp__github__add_issue_comment', { owner: 'o', repo: 'r', issue_number: 4, body: 'secret' }), 'mcp__github__add_issue_comment o/r #4')
  // A NAME=value word in front may hold a secret: it is skipped, and a first word with odd characters reads as plain bash. The row is redacted as well.
  assert.equal(p.patternOf('Bash', { command: j('GH_TO', 'KEN=x1 PGPASS', 'WORD=y psql -c x') }), 'psql')
  assert.equal(p.patternOf('Bash', { command: j('GH_TO', 'KEN=x1') }), 'bash')
  assert.equal(p.patternOf('Bash', { command: '$(curl evil) x' }), 'bash')
  assert.equal(p.ledgerLine({ t: 't', kind: 'floor', pattern: j('gh', 'p_abc123') }).includes('abc123'), false)
  assert.equal(p.patternOf('Edit', { file_path: '/r/src/a.ts' }, '/r'), 'Edit src/a.ts')
  assert.equal(p.patternOf('Edit', { file_path: '/elsewhere/a.ts' }, '/r'), 'Edit <outside>')
  assert.equal(p.patternOf('WebFetch', { url: 'https://x' }), 'WebFetch')
})

// ---- the switch ----
test('answering: off by default, scope and asks parsed, a look-alike covers nothing', () => {
  assert.equal(p.parseAnswering(undefined), undefined)
  assert.equal(p.parseAnswering({ scope: 'all', asks: false }), undefined)
  assert.deepEqual(p.parseAnswering({ scope: 'LANE1', asks: false, savedAt: 1 }), { scope: 'LANE1', asks: false, savedAt: 1 })
  assert.equal(p.parseAnswering({ scope: 'bad name', asks: false, savedAt: 1 }), undefined)
  assert.equal(p.covers(undefined, { lane: 'L' }), false)
  const a = { scope: 'LEAD', asks: false, savedAt: 1 }
  assert.equal(p.covers(a, { lane: 'L', lead: 'LEAD' }), true)
  assert.equal(p.covers(a, { lane: 'L', lead: 'LEAD2' }), false)
  assert.equal(p.covers(a, { self: 'LEAD' }), true)
  assert.equal(p.covers({ scope: 'all', asks: false, savedAt: 1 }, {}), true)
  assert.equal(p.covers({ scope: 'lane1', asks: false, savedAt: 1 }, { lane: 'LANE1' }), false)
})
test('answering args: show, off, off asks, on SCOPE [asks], anything else bad', () => {
  assert.equal(p.parseAnsweringArgs(undefined), 'show')
  assert.equal(p.parseAnsweringArgs(' '), 'show')
  assert.equal(p.parseAnsweringArgs('off'), 'off')
  assert.equal(p.parseAnsweringArgs('off asks'), 'off-asks')
  assert.deepEqual(p.parseAnsweringArgs('on all'), { on: 'all', asks: false })
  assert.deepEqual(p.parseAnsweringArgs('on LANE-1 asks'), { on: 'LANE-1', asks: true })
  for (const bad of ['on', 'on a b', 'on x asks y', 'on bad/name', 'enable', 'off all', 'on a\nb']) assert.equal(p.parseAnsweringArgs(bad), 'bad', bad)
})
