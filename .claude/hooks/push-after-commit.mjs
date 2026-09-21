#!/usr/bin/env node
// Push to origin after a successful `git commit`.
//
// Wired from .claude/settings.json as a PostToolUse hook on Bash. PostToolUse only
// fires after the tool succeeded, so reaching here means the commit was created.
//
// Deliberately never forces and never merges: a rejected push is reported and left
// alone, because resolving divergence is a decision for a human (see CLAUDE.md).

import { execFileSync } from 'node:child_process';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let cmd = '';
  try {
    cmd = JSON.parse(raw)?.tool_input?.command ?? '';
  } catch {
    process.exit(0); // unparseable payload is not our problem to report
  }

  // Match a real commit anywhere in a compound command (`cd x && git commit -m ...`),
  // allowing global flags like `git -c user.name=x commit`.
  const isCommit = /(^|[;&|\n])\s*git\s+(-\S+\s+|-c\s+\S+\s+)*commit(\s|$)/.test(cmd);
  if (!isCommit) process.exit(0);
  if (/--dry-run/.test(cmd)) process.exit(0);

  const report = (systemMessage) => {
    process.stdout.write(JSON.stringify({ systemMessage }));
    process.exit(0);
  };

  const git = (...args) =>
    execFileSync('git', args, {
      encoding: 'utf8',
      timeout: 30_000,
      // Fail fast instead of hanging on a credential prompt in a non-interactive hook.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  try {
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    git('push', 'origin', branch);
    report(`Auto-push: ${branch} → origin`);
  } catch (err) {
    const detail = `${err.stderr ?? ''}${err.stdout ?? ''}`.trim() || err.message;
    const tail = detail.split('\n').filter(Boolean).slice(-3).join(' · ');
    report(`Auto-push FAILED — not retried, not forced: ${tail}`);
  }
});
