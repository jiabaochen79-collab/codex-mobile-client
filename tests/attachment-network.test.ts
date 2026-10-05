import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useAttachments } from '../web/use-attachments.js';
import type { Attachment, Command } from '../src/shared/protocol.js';

afterEach(() => vi.restoreAllMocks());
describe('attachment offset recovery', () => {
  it('removes a reservation confirmed after the user cancelled upload initialization', async () => {
    const task = randomUUID();
    const attachment: Attachment = { id: randomUUID(), name: 'cancelled.txt', size: 4, mediaType: 'text/plain', offset: 0, ready: false };
    let deliver!: (value: Attachment) => void;
    const request = vi.fn((command: Command) => command.method === 'upload.begin'
      ? new Promise<Attachment>(resolve => { deliver = resolve; }) : Promise.resolve({ removed: true }));
    const uploads = useAttachments({ thread: () => task, request, control: () => ({ clientId: randomUUID(), allowed: true }) });
    const adding = uploads.add([new File(['test'], attachment.name)]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await uploads.remove(uploads.current.value[0]);
    deliver(attachment); await adding;
    expect(uploads.current.value).toHaveLength(0);
    expect(request).toHaveBeenLastCalledWith({ method: 'upload.remove', params: { attachmentId: attachment.id } });
  });
  it('restores completed attachment references without uploading empty placeholder files', () => {
    const task = randomUUID(); const request = vi.fn();
    const uploads = useAttachments({ thread: () => task, request, control: () => ({ clientId: randomUUID(), allowed: true }) });
    const file = { id: randomUUID(), name: 'saved.txt', size: 100, mediaType: 'text/plain', offset: 100, ready: true };
    uploads.restore(task, [file]); uploads.restore(task, [file]);
    expect(uploads.current.value).toHaveLength(1); expect(uploads.current.value[0].attachment).toEqual(file); expect(request).not.toHaveBeenCalled();
    uploads.clear(); expect(uploads.current.value).toHaveLength(0);
  });
  it('resumes from the confirmed offset after a lost PUT reply', async () => {
    const task = randomUUID(), epoch = randomUUID(); const file = new File([new Uint8Array(32768)], 'fixture.txt');
    const attachment: Attachment = { id: randomUUID(), name: file.name, size: file.size, mediaType: 'text/plain', offset: 0, ready: false };
    const commands: string[] = [], offsets: number[] = [];
    const request = async (command: Command) => { commands.push(command.method); if (command.method === 'upload.complete') attachment.ready = true; return structuredClone(attachment); };
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const offset = Number(String(url).split('/').at(-1)); offsets.push(offset);
      attachment.offset = offset + (init!.body as Blob).size;
      if (offsets.length === 1) throw new TypeError('Lost acknowledgement after durable write');
      return Response.json(attachment);
    });
    const uploads = useAttachments({ thread: () => task, request, control: () => ({ clientId: randomUUID(), epoch, allowed: true }) });
    await uploads.add([file]);
    expect(offsets).toEqual([0, 16384]); expect(commands).toEqual(['upload.begin','upload.status','upload.complete']);
    expect(uploads.current.value[0].attachment?.ready).toBe(true); expect(uploads.current.value[0].error).toBe(''); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not retry after ownership changes during a transfer', async () => {
    const task = randomUUID(), oldEpoch = randomUUID(); let epoch = oldEpoch;
    const file = new File([new Uint8Array(32768)], 'fixture.txt');
    const request = vi.fn(async () => ({ id: randomUUID(), name: file.name, size: file.size, offset: 0, ready: false }));
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { epoch = randomUUID(); throw new TypeError('Connection lost'); });
    const uploads = useAttachments({ thread: () => task, request, control: () => ({ clientId: randomUUID(), epoch, allowed: true }) });
    await uploads.add([file]); expect(fetch).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(1);
    expect(uploads.current.value[0].error).toContain('控制权已改变');
  });
});
