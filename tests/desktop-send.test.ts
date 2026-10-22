import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { CodexDesktop, normalizeSnapshot } from '../src/agent/desktop.js';
import { NativeIpc } from '../src/agent/ipc.js';
import { commandSchema, isSafetyCommand, type Snapshot } from '../src/shared/protocol.js';

afterEach(() => vi.restoreAllMocks());

function idleDesktop() {
  const adapter = new CodexDesktop('unused', resolve('fixture-codex-home'));
  const snapshot: Snapshot = { id: randomUUID(), title: 'Fixture', epoch: 'fixture-epoch', turnId: null, busy: false, messages: [], requests: [], hasMore: false };
  vi.spyOn(adapter as any, 'ready').mockResolvedValue(undefined);
  vi.spyOn(adapter as any, 'follow').mockResolvedValue(undefined);
  vi.spyOn(adapter as any, 'snapshot').mockReturnValue(snapshot);
  Reflect.set(adapter, 'current', { id: snapshot.id, owner: 'desktop-owner', revision: 0, state: {} });
  Reflect.set(adapter, 'discovery', { processId: 123, startedAt: 'fixture-start', executablePath: 'C:/Codex.exe', toolsPipe: 'fixture-tools' });
  return { adapter, snapshot };
}

describe('desktop remote-send contract', () => {
  it('steers the active turn with native input and does not interrupt or restart it', async () => {
    const { adapter, snapshot } = idleDesktop(); snapshot.busy = true; snapshot.turnId = 'active-turn'; const commandId = randomUUID();
    const request = vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({ resultType: 'success' });
    try {
      await adapter.execute({ method: 'send', params: { id: snapshot.id, epoch: snapshot.epoch, text: '调整这一点', mode: 'steer', turnId: 'active-turn' } }, commandId);
      expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0][0]).toBe('thread-follower-steer-turn'); expect(request.mock.calls[0][2]).toBe(1);
      const body = request.mock.calls[0][1] as any; expect(body.input).toEqual([{ type: 'text', text: '调整这一点', text_elements: [] }]); expect(body.restoreMessage.context.commentAttachments).toEqual([]); expect(body.clientUserMessageId).toBe(commandId); expect(body).not.toHaveProperty('turnStart');
    } finally { adapter.close(); }
  });
  it('does not steer an ended or different turn, queue through a destructive native replacement, or drop attachments', async () => {
    const { adapter, snapshot } = idleDesktop(); const request = vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({ resultType: 'success' });
    const command = { method: 'send' as const, params: { id: snapshot.id, epoch: snapshot.epoch, text: 'test', mode: 'steer' as const, turnId: 'old' } };
    try {
      await expect(adapter.execute(command, randomUUID())).rejects.toMatchObject({ code: 'STALE' }); snapshot.busy = true; snapshot.turnId = 'new';
      await expect(adapter.execute(command, randomUUID())).rejects.toMatchObject({ code: 'STALE' });
      await expect(adapter.execute({ ...command, params: { ...command.params, turnId: 'new' } }, randomUUID(), undefined, [{ id: randomUUID(), name: 'file.txt', size: 1, offset: 1, ready: true, mediaType: 'text/plain', path: 'C:/fixture/file.txt' }])).rejects.toMatchObject({ code: 'UNSUPPORTED' });
      await expect(adapter.execute({ ...command, params: { ...command.params, mode: 'queue' } }, randomUUID())).rejects.toMatchObject({ code: 'INVALID' }); expect(request).not.toHaveBeenCalled();
      expect(commandSchema.safeParse({ method: 'send', params: { id: snapshot.id, epoch: snapshot.epoch, text: 'test', mode: 'steer' } }).success).toBe(false);
    } finally { adapter.close(); }
  });
  it('renders steering input as user content and exposes the latest native turn state', () => {
    const snapshot = normalizeSnapshot({ id: randomUUID(), turns: [{ turnId: 'turn-1', status: 'inProgress', items: [{ id: 'steering-1', type: 'steeringUserMessage', input: [{ type: 'text', text: '改用另一种方案', text_elements: [] }], status: 'accepted' }] }] }, 'epoch');
    expect(snapshot.lastTurnStatus).toBe('inProgress'); expect(snapshot.lastTurnId).toBe('turn-1'); expect(snapshot.messages[0]).toMatchObject({ role: 'user', text: '改用另一种方案' });
  });
  it('does not treat input answers disguised as a decline as a safety command', () => {
    const command = { method:'respond' as const,params:{id:randomUUID(),requestId:1,epoch:'fixture',decision:'decline' as const,answers:{question:['continue']}} };
    expect(commandSchema.safeParse(command).success).toBe(false); expect(isSafetyCommand(command)).toBe(false);
  });
  it('never submits an input response through the decline path', async () => {
    const {adapter,snapshot}=idleDesktop();snapshot.requests=[{id:1,kind:'input',title:'Input',detail:'',questions:[]}];
    const request=vi.spyOn(NativeIpc.prototype,'request').mockResolvedValue({resultType:'success'});
    try {await expect(adapter.execute({method:'respond',params:{id:snapshot.id,epoch:snapshot.epoch,requestId:1,decision:'decline'}},randomUUID())).rejects.toMatchObject({code:'INVALID'});expect(request).not.toHaveBeenCalled();}
    finally {adapter.close();}
  });
  it('supplies the text element array required by the desktop optimistic renderer', async () => {
    const { adapter, snapshot } = idleDesktop();
    const commandId = randomUUID();
    const request = vi.spyOn(NativeIpc.prototype, 'request').mockImplementation(async (_method, params: any) => {
      // The desktop inspects this array before the model API normalizes the input.
      expect(params.turnStart.request.input[0].text_elements.length).toBe(0);
      return { resultType: 'success' };
    });
    try {
      await expect(adapter.execute({ method: 'send', params: { id: snapshot.id, epoch: snapshot.epoch, text: 'Hello' } }, commandId)).resolves.toEqual({ accepted: true });
      expect(request).toHaveBeenCalledWith('thread-follower-start-turn', {
        conversationId: snapshot.id,
        turnStart: {
          request: { threadId: snapshot.id, input: [{ type: 'text', text: 'Hello', text_elements: [] }], clientUserMessageId: commandId },
          context: { inheritThreadSettings: true, attachments: [], commentAttachments: [] }
        }
      }, 2, 'desktop-owner');
    } finally { adapter.close(); }
  });

  it('preserves literal text and leaves model and permission settings inherited', async () => {
    const { adapter, snapshot } = idleDesktop();
    const request = vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({ resultType: 'success' });
    const text = '你好\n请仅检查状态。';
    try {
      await adapter.execute({ method: 'send', params: { id: snapshot.id, epoch: snapshot.epoch, text } }, randomUUID());
      const params = request.mock.calls[0][1] as any;
      expect(params.turnStart.request.input).toEqual([{ type: 'text', text, text_elements: [] }]);
      expect(params.turnStart.context.inheritThreadSettings).toBe(true);
      expect(params.turnStart.request).not.toHaveProperty('model');
      expect(params.turnStart.request).not.toHaveProperty('approvalPolicy');
    } finally { adapter.close(); }
  });
  it('passes confirmed local attachments through the native file context and image input', async()=>{
    const {adapter,snapshot}=idleDesktop();const request=vi.spyOn(NativeIpc.prototype,'request').mockResolvedValue({resultType:'success'});
    try {
      await adapter.execute({method:'send',params:{id:snapshot.id,epoch:snapshot.epoch,text:'Read these files.',attachmentIds:[]}},randomUUID(),undefined,[{id:randomUUID(),name:'report.txt',size:12,mediaType:'application/octet-stream',offset:12,ready:true,path:'C:/safe/report.txt'},{id:randomUUID(),name:'image.png',size:100,mediaType:'image/png',offset:100,ready:true,path:'C:/safe/image.png'}]);
      const p=request.mock.calls[0][1] as any;
      expect(p.turnStart.request.input[0].text).toContain('## report.txt: C:/safe/report.txt');
      expect(p.turnStart.request.input[0].text_elements).toEqual([]);expect(p.turnStart.request.input[1]).toEqual({type:'localImage',path:'C:/safe/image.png'});
      expect(p.turnStart.context.inheritThreadSettings).toBe(true);expect(p.turnStart.request).not.toHaveProperty('sandboxPolicy');
    }finally{adapter.close();}
  });
});
