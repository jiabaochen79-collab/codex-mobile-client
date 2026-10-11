import { spawn } from 'node:child_process';
import type { Interaction } from '../shared/protocol.js';
import { RemoteError } from '../shared/protocol.js';

export async function submitDesktopQuestion(nativeExe: string, identity: { processId: number; startedAt?: string; executablePath: string | null }, title: string, request: Interaction, answers: Record<string, string[]>, authorize: () => Promise<void>) {
  if (!identity.startedAt || !identity.executablePath || !title) throw new RemoteError('CLIENT_UNAVAILABLE', '无法核对电脑提问窗口，请稍后重试。');
  await authorize();
  return new Promise<{ closed: boolean }>((resolve, reject) => {
    const child = spawn(nativeExe, ['--desktop-question'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '', submitted = false, prepared = false, committing = false, finished = false, closed = false;
    const finish = (error?: unknown) => {
      if (finished) return; finished = true; clearTimeout(timer); child.stdin.end();
      if (error || !submitted) { child.kill(); reject(error ?? new RemoteError(committing ? 'OUTCOME_UNKNOWN' : 'CLIENT_UNAVAILABLE', committing ? '提问提交结果未确认，请核对原会话，勿重复提交。' : '未找到对应的电脑提问卡片，操作未提交。')); }
      else resolve({ closed });
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
          } else if (result.submitted === true && committing && typeof result.closed === 'boolean') { submitted = true; closed = result.closed; }
          else if (result.error) finish(new RemoteError(result.error === 'OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : 'CLIENT_UNAVAILABLE', result.error === 'OUTCOME_UNKNOWN' ? '提问提交结果未确认，请核对原会话，勿重复提交。' : '电脑提问卡片未就绪或已有未提交草稿，请在电脑核对后重试。'));
          else finish();
        } catch { finish(); }
      }
    });
    child.once('close', code => finish(code !== 0 ? new RemoteError(committing ? 'OUTCOME_UNKNOWN' : 'CLIENT_UNAVAILABLE', '电脑提问操作未确认，请核对原会话。') : undefined));
    child.stdin.write(JSON.stringify({ ...identity, title, answers: request.questions?.map(question => ({ question: question.question, answer: answers[question.id][0].trim() })) }) + '\n');
  });
}
