const assert = require('assert');
const os = require('os'), fs = require('fs'), path = require('path'), cp = require('child_process');
const A = require('../out/attribution/claudeAttribution');
const I = require('../out/attribution/claudeHookInstaller');
const S = require('../out/attribution/claudeHookSource');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ✓', m); };

const n = p => A.normalizeFsPath(p);
const ev = (event, at, { sid = 's1', cwd = '/ws' } = {}) => A.parseHookEvent(JSON.stringify({
  hook_event_name: event, session_id: sid, cwd }), at);
const make = (opts = {}) => new A.ClaudeAttribution({ workspaceFolders: () => [n('/ws')], ...opts });
const GRACE = A.DEFAULT_TIMINGS.stopGraceMs;

console.log('Turn window');
{
  const a = make();
  ok(!a.isClaudeWrite('/ws/copied.txt', 1000), 'no turn → file copied in is NOT Claude');
  a.ingest(ev('UserPromptSubmit', 1000));
  ok(a.isClaudeWrite('/ws/a.ts', 1500), 'write during the turn → Claude');
  ok(!a.isClaudeWrite('/ws/a.ts', 999), 'write before the turn start → NOT Claude');
  a.ingest(ev('Stop', 5000));
  ok(a.isClaudeWrite('/ws/a.ts', 5000 + GRACE), 'change notice within the grace after Stop → Claude');
  ok(!a.isClaudeWrite('/ws/a.ts', 5000 + GRACE + 1), 'write after Stop + grace → NOT Claude');
}
{
  const a = make();
  a.ingest(ev('UserPromptSubmit', 1000));
  a.ingest(ev('PreToolUse', 1200)); // leftover per-edit event: ignored
  ok(a.isClaudeWrite('/ws/doc.qmd', 3000) && a.isClaudeWrite('/ws/doc.qmd', 3400),
    'two quick writes to one file with no per-edit events → both Claude (the reported bug)');
  ok(a.isClaudeWrite('/ws/doc.qmd', 20000), 'late change notice inside a long turn → Claude');
}
{
  const a = make();
  ok(A.parseHookEvent(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Edit' }), 1) !== undefined,
    'leftover PostToolUse event parses');
  a.ingest(ev('PreToolUse', 1000));
  a.ingest(ev('PostToolUse', 1100));
  ok(!a.isClaudeWrite('/ws/a.ts', 1050), 'PreToolUse/PostToolUse alone open no turn');
}

console.log('Workspace filter');
{
  const a = make({ workspaceFolders: () => [n('/ws/proj')] });
  a.ingest(ev('UserPromptSubmit', 1000, { sid: 'other', cwd: '/elsewhere' }));
  ok(!a.isClaudeWrite('/ws/proj/a.ts', 1500), 'turn of a session in another project does not cover this workspace');
  a.ingest(ev('UserPromptSubmit', 2000, { sid: 'parent', cwd: '/ws' }));
  ok(a.isClaudeWrite('/ws/proj/a.ts', 2500), 'turn whose cwd is a parent of the workspace folder covers it');
}
{
  const a = make({ workspaceFolders: () => [n('/ws/proj')] });
  a.ingest(ev('UserPromptSubmit', 1000, { cwd: '/ws/proj/sub' }));
  ok(a.isClaudeWrite('/ws/proj/a.ts', 1500), 'turn whose cwd is inside the workspace folder covers it');
}
{
  // Mapped drive vs UNC path: both sides resolve to the same real path.
  const real = p => n(p).replace(n('/alias'), n('/real'));
  const a = make({ workspaceFolders: () => [n('/real/ws')], canonicalize: real });
  a.ingest(ev('UserPromptSubmit', 1000, { cwd: '/alias/ws' }));
  ok(a.isClaudeWrite('/real/ws/a.ts', 1500), 'cwd and folder compared after canonicalize (P:\\ vs \\\\server\\share)');
  ok(a.cwdMatchesWorkspace(n('/alias/ws')) && !a.cwdMatchesWorkspace(n('/elsewhere')), 'cwdMatchesWorkspace');
}
{
  let mismatch = 0;
  const a = make({ onCwdMismatch: () => mismatch++ });
  a.ingest(ev('UserPromptSubmit', 1000, { cwd: '/elsewhere' }));
  a.isClaudeWrite('/ws/a.ts', 1500);
  ok(mismatch === 1, 'cwd mismatch is reported (for the log)');
}

console.log('Turn lifecycle');
{
  const a = make();
  a.ingest(ev('UserPromptSubmit', 1000)); // its Stop never arrives
  a.ingest(ev('UserPromptSubmit', 5000));
  a.ingest(ev('Stop', 6000));
  ok(!a.isClaudeWrite('/ws/a.ts', 6000 + GRACE + 1), 'missed Stop: the next turn start closes the earlier turn');
}
{
  const a = make({ timings: { stopGraceMs: 100, maxOpenMs: 10_000 } });
  a.ingest(ev('UserPromptSubmit', 1000));
  ok(a.isClaudeWrite('/ws/a.ts', 11_100), 'open turn with no Stop still covers writes up to maxOpen + grace');
  ok(!a.isClaudeWrite('/ws/a.ts', 11_101), 'open turn with no Stop expires after maxOpen + grace');
  a.prune(11_101 + 60_001);
  ok(!a.isClaudeWrite('/ws/a.ts', 5000), 'expired turn is pruned');
}
{
  const a = make();
  a.ingest(ev('UserPromptSubmit', 1000));
  a.prune(2_000_000);
  ok(a.isClaudeWrite('/ws/a.ts', 2_000_000), 'prune keeps an open turn that is still in its window');
}
{
  const a = make();
  a.ingest(ev('UserPromptSubmit', 1000, { sid: 'x' }));
  a.ingest(ev('UserPromptSubmit', 1000, { sid: 'y' }));
  a.ingest(A.parseHookEvent(JSON.stringify({ hook_event_name: 'Stop' }), 2000));
  ok(!a.isClaudeWrite('/ws/a.ts', 2000 + GRACE + 1), 'Stop without session_id closes every open turn');
}
{
  const calls = [];
  const a = make({ onStopWithoutStart: info => calls.push(info) });
  a.ingest(ev('UserPromptSubmit', 1000));
  a.ingest(ev('Stop', 2000));
  ok(calls.length === 0, 'normal turn: no missed-start report');
  a.ingest(ev('Stop', 9000)); // turn start hook failed
  ok(calls.length === 1 && calls[0].since === 2000 && calls[0].at === 9000 && calls[0].sessionId === 's1',
    'Stop without turn start is reported with the previous Stop as `since`');
  a.ingest(ev('Stop', 12000), true);
  ok(calls.length === 1, 'historical Stop (startup catch-up) is never reported');
}

console.log('Parsing');
{
  ok(A.parseHookEvent('\uFEFF{"hook_event_name":"Stop"}', 1) !== undefined, 'BOM-prefixed payload parses');
  ok(A.parseHookEvent('garbage', 1) === undefined, 'garbage payload ignored');
  ok(A.parseHookEvent('{"hook_event_name":"Notification"}', 1) === undefined, 'unknown event ignored');
  ok(A.normalizeFsPath('C:\\Proj\\A.ts', 'win32') === A.normalizeFsPath('C:\\Proj\\A.ts', 'win32').toLowerCase(), 'win32 paths lowercased');
  ok(A.isInside(n('/ws/a'), n('/ws')) && !A.isInside(n('/wsx/a'), n('/ws')), 'isInside respects path boundaries');
}

console.log('settings.json installer');
{
  const user = { model: 'opus', hooks: {
    PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'my-guard.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] } };
  const raw = JSON.stringify(user, null, 2);
  const r1 = I.computeHookSettings(raw, true, 'linux');
  const s1 = JSON.parse(r1.content);
  ok(r1.changed, 'install changes settings');
  ok(s1.model === 'opus' && s1.hooks.PreToolUse.length === 1 && s1.hooks.Stop.length === 2,
    'user hooks + other settings preserved');
  ok(!s1.hooks.PostToolUse, 'no PostToolUse hook installed');
  const ups = s1.hooks.UserPromptSubmit;
  ok(ups.length === 1 && ups[0].matcher === undefined && ups[0].hooks[0].timeout === 30,
    'UserPromptSubmit installed without matcher, timeout 30');
  ok(s1.hooks.Stop[1].hooks[0].timeout === 30, 'Stop installed with timeout 30');
  ok(!I.computeHookSettings(r1.content, true, 'linux').changed, 'second install is a no-op (no rewrite)');
  const r3 = JSON.parse(I.computeHookSettings(r1.content, false, 'linux').content);
  ok(JSON.stringify(r3) === JSON.stringify(user), 'uninstall restores exactly the original config');

  // Upgrade from the per-edit design: our old PreToolUse/PostToolUse entries go.
  const oldCmd = { type: 'command', timeout: 5,
    command: 'd="$HOME/.ai-cli-diff-view/claude-events"; mkdir -p "$d" && cat > "$d/x.json"; exit 0' };
  const oldMatcher = '^(Write|Edit|MultiEdit|NotebookEdit|Bash)$';
  const old = JSON.parse(raw);
  old.hooks.PreToolUse.push({ matcher: oldMatcher, hooks: [oldCmd] });
  old.hooks.PostToolUse = [{ matcher: oldMatcher, hooks: [oldCmd] }];
  old.hooks.Stop.push({ hooks: [oldCmd] });
  const up = I.computeHookSettings(JSON.stringify(old, null, 2), true, 'linux');
  const su = JSON.parse(up.content);
  ok(up.changed && su.hooks.PreToolUse.length === 1 && su.hooks.PreToolUse[0].hooks[0].command === 'my-guard.sh',
    'upgrade removes our old PreToolUse entry, keeps the user\'s');
  ok(!su.hooks.PostToolUse, 'upgrade removes our old PostToolUse entry');
  ok(su.hooks.Stop.length === 2 && su.hooks.Stop[1].hooks[0].timeout === 30, 'upgrade replaces our old Stop entry');
  ok(su.hooks.UserPromptSubmit.length === 1, 'upgrade adds UserPromptSubmit');
  ok(JSON.stringify(JSON.parse(I.computeHookSettings(JSON.stringify(old), false, 'linux').content)) === JSON.stringify(user),
    'uninstall over the old version also restores the original config');

  ok(I.computeHookSettings('{ broken', true, 'linux').parseError, 'malformed settings.json → refuse to write');
  {
    const r = I.computeHookSettings('{ broken', false, 'linux');
    ok(!r.parseError && !r.changed, 'feature off + unparseable file without our hook → silent no-op (startup case)');
  }
  ok(I.computeHookSettings('{ broken ' + 'ai-cli-diff-view/claude-events', false, 'linux').parseError,
    'feature off + unparseable file that contains our hook → refuse to write');
  {
    const withBom = '\uFEFF' + raw;
    const rb = I.computeHookSettings(withBom, true, 'linux');
    ok(!rb.parseError && rb.changed, 'UTF-8 BOM settings.json parses (Notepad/PowerShell)');
    ok(rb.content.startsWith('\uFEFF') && JSON.parse(rb.content.slice(1)).model === 'opus', 'BOM preserved, settings kept');
    const ru = I.computeHookSettings(rb.content, false, 'linux').content;
    ok(ru.startsWith('\uFEFF') && JSON.stringify(JSON.parse(ru.slice(1))) === JSON.stringify(user),
      'BOM file: uninstall restores original settings');
  }
  const w = JSON.parse(I.computeHookSettings('', true, 'win32').content);
  ok(w.hooks.UserPromptSubmit[0].hooks[0].shell === 'powershell' && w.hooks.UserPromptSubmit[0].hooks[0].timeout === 30,
    'Windows uses powershell hook, timeout 30');
}

(async () => {
  const isWin = process.platform === 'win32';
  const hasPwsh = (() => { try { cp.execSync('pwsh -NoProfile -c "exit 0"', { stdio: 'ignore' }); return true; } catch { return false; } })();
  const ws = isWin ? 'C:\\ws\\thư mục' : '/ws/thư mục';
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: ws,
    prompt: 'sửa ghi chú "quoted" $notAVar `tick`' };

  async function endToEnd(label, platform, shell, homeVar) {
    console.log(`End-to-end (${label}): real hook command → event files → source`);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    const cmd = JSON.parse(I.computeHookSettings('', true, platform).content).hooks.UserPromptSubmit[0].hooks[0].command;
    const stdout = cp.execSync(cmd, { input: Buffer.from(JSON.stringify(payload), 'utf8'),
      env: { ...process.env, [homeVar]: home }, shell });
    ok(stdout.length === 0, `${label}: hook prints nothing (UserPromptSubmit stdout would reach Claude's context)`);
    const dir = path.join(home, '.ai-cli-diff-view', 'claude-events');
    const files = fs.readdirSync(dir);
    ok(files.length === 1 && files[0].endsWith('.json'), `${label}: hook wrote exactly one .json event file (no leftover .tmp)`);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    ok(stored.cwd === ws && stored.prompt === payload.prompt, `${label}: non-ASCII payload stored byte-exact`);
    const src = new S.ClaudeHookSource(new A.ClaudeAttribution({ workspaceFolders: () => [n(ws)] }), dir);
    ok(await src.isClaudeWrite(path.join(ws, 'ghi chú.md'), Date.now()), `${label}: write during the recorded turn attributed`);
    ok(src.hasSeenAnyEvent(), `${label}: source reports hook is alive`);
  }

  if (isWin) {
    await endToEnd('Windows PowerShell', 'win32', 'powershell.exe', 'USERPROFILE');
  } else {
    await endToEnd('sh', 'linux', '/bin/sh', 'HOME');
    if (hasPwsh) { await endToEnd('pwsh', 'win32', 'pwsh', 'USERPROFILE'); }
  }

  console.log('Event source');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'events-'));
    let missed = 0;
    const src = new S.ClaudeHookSource(make({ onStopWithoutStart: () => missed++ }), dir);
    await new Promise(r => setTimeout(r, 20)); // event below is newer than the source → not historical
    fs.writeFileSync(path.join(dir, 'stop.json'), JSON.stringify({ hook_event_name: 'Stop', session_id: 's9', cwd: '/ws' }));
    await Promise.all([src.refresh(), src.refresh(), src.refresh()]);
    ok(missed === 1, 'overlapping reads ingest a new Stop exactly once');
  }
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'events-'));
    fs.writeFileSync(path.join(dir, 'start.json'), JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's8', cwd: '/ws' }));
    const tenMinAgo = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(path.join(dir, 'start.json'), tenMinAgo, tenMinAgo);
    let missed = 0;
    const src = new S.ClaudeHookSource(make({ onStopWithoutStart: () => missed++ }), dir);
    ok(await src.isClaudeWrite('/ws/a.ts', Date.now()), 'startup catch-up: a turn started 10 min before the window covers writes now');
    fs.writeFileSync(path.join(dir, 'stop.json'), JSON.stringify({ hook_event_name: 'Stop', session_id: 's8', cwd: '/ws' }));
    await src.refresh();
    ok(missed === 0, 'startup catch-up: that turn\'s Stop is not a missed start');
  }

  console.log(`\n${pass} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
