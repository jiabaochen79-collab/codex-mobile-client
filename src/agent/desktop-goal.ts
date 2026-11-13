import { spawn } from 'node:child_process';
import { RemoteError, type ThreadGoal } from '../shared/protocol.js';

// The desktop's goal buttons use its existing app-server connection. A separate
// app-server process can change the stored goal without notifying that desktop.
export async function operateDesktopGoal(nativeExe: string, identity: { processId: number; startedAt?: string; executablePath: string | null }, title: string, goal: ThreadGoal, action: 'resume' | 'clear', authorize: () => Promise<void>) {
  if (!identity.startedAt || !identity.executablePath || !title) throw new RemoteError('CLIENT_UNAVAILABLE', '无法核对电脑目标面板，请稍后重试。');
  await authorize();
  return new Promise<void>((resolve, reject) => {
    const child = spawn(nativeExe, ['--desktop-goal'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '', prepared = false, committing = false, submitted = false, finished = false;
    const finish = (error?: unknown) => {
      if (finished) return; finished = true; clearTimeout(timer); child.stdin.end();
      if (error || !submitted) { child.kill(); reject(error ?? new RemoteError(committing ? 'OUTCOME_UNKNOWN' : 'CLIENT_UNAVAILABLE', committing ? '目标操作结果待确认，请重新同步后核对，勿重复操作。' : '未定位到对应的电脑目标面板，请确认电脑已解锁且 Codex 正常运行。')); }
      else resolve();
    };
    const timer = setTimeout(() => finish(), 20000);
    child.stdin.on('error', () => finish()); child.once('error', () => finish());
    child.stdout.on('data', bytes => {
      buffer += bytes;
      if (buffer.length > 4096) { finish(); return; }
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const result = JSON.parse(line);
          if (result.ready === true && !prepared) {
            prepared = true;
            void authorize().then(() => { if (!finished) { committing = true; child.stdin.write('submit\n'); } }, finish);
          } else if (result.submitted === true && committing) submitted = true;
          else if (result.error === 'OUTCOME_UNKNOWN') finish(new RemoteError('OUTCOME_UNKNOWN', '目标操作结果待确认，请重新同步后核对，勿重复操作。'));
          else finish();
        } catch { finish(); }
      }
    });
    child.once('close', code => finish(code !== 0 ? new RemoteError(committing ? 'OUTCOME_UNKNOWN' : 'CLIENT_UNAVAILABLE', '电脑目标操作未确认，请重新同步后核对。') : undefined));
    child.stdin.write(JSON.stringify({ ...identity, title, objective: goal.objective, action }) + '\n');
  });
}
