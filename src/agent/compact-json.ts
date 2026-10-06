import parser from 'stream-json/core/parser.js';
import ignoreFilter from 'stream-json/core/filters/ignore.js';
import Assembler from 'stream-json/assembler.js';
import { fun, none } from 'stream-chain/core';
import { open } from 'node:fs/promises';

export function compactJson(ignore: RegExp, limit: number, value: (result: any) => void, error: (reason: Error) => void) {
  const assembler = new Assembler();
  let retained = 0, failed = false, strings: string[] = [];
  let depth = 0;
  const fail = (reason: Error) => { if (failed) return; failed = true; error(reason); };
  const pipeline = fun(parser({ packStrings: false, streamStrings: true, streamKeys: false, streamNumbers: false }), (token: parser.Token) => {
    if (token.name === 'startObject' || token.name === 'startArray') { if (++depth > 128) throw new Error('JSON depth exceeds limit'); }
    if (token.name === 'endObject' || token.name === 'endArray') depth--;
    if (token.name === 'keyValue' && ['__proto__', 'prototype', 'constructor'].includes(token.value)) throw new Error('Unsafe JSON key');
    return token;
  }, ignoreFilter({ filter: ignore, maxDepth: 128 }), (token: parser.Token) => {
      retained += 'value' in token && typeof token.value === 'string' ? Buffer.byteLength(token.value) : 8;
      if (retained > limit || assembler.depth > 128) throw new Error('JSON retained state exceeds limit');
      if (token.name === 'startString') strings = [];
      else if (token.name === 'stringChunk') strings.push(token.value);
      else if (token.name === 'endString') { assembler.consume({ name: 'stringValue', value: strings.join('') }); strings = []; }
      else assembler.consume(token);
      return none;
  });
  const run = (bytes: any) => { if (!failed) try { pipeline(bytes); } catch (reason) { fail(reason as Error); } };
  return {
    write: (bytes: Buffer) => { for (let offset = 0; offset < bytes.length && !failed; offset += 65536) run(bytes.subarray(offset, offset + 65536)); },
    end: () => { run(none); if (!failed) { if (assembler.done) value(assembler.current); else fail(new Error('Incomplete JSON')); } },
    destroy: () => { failed = true; strings = []; }
  };
}

export async function readCompactRecord(path: string, offset: number) {
  const file = await open(path, 'r'); let parsed!: (result: { value?: any; error?: Error }) => void;
  const result = new Promise<{ value?: any; error?: Error }>(resolve => { parsed = resolve; });
  const parser = compactJson(/^payload\.(last_agent_message|text|content|arguments|summary)$/, 1024 * 1024, value => parsed({ value }), error => parsed({ error }));
  const bytes = Buffer.alloc(65536); let position = offset;
  try {
    while (position - offset < 256 * 1024 * 1024) {
      const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
      if (!bytesRead) return undefined;
      const end = bytes.subarray(0, bytesRead).indexOf(10);
      parser.write(bytes.subarray(0, end < 0 ? bytesRead : end));
      if (end >= 0) {
        parser.end(); const record = await result;
        return { value: record.value, offset: position + end + 1 };
      }
      position += bytesRead;
    }
    throw new Error('JSONL record exceeds input limit');
  } finally { parser.destroy(); await file.close(); }
}
