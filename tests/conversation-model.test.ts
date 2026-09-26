import { describe, expect, it } from 'vitest';
import type { Message, Snapshot } from '../src/shared/protocol.js';
import { normalizeSnapshot } from '../src/agent/desktop.js';
import { conversationTurns } from '../web/conversation-model.js';
const snapshot = (messages: Message[], busy = false): Snapshot => ({ id:'task',title:'Task',epoch:'epoch',turnId:busy?'t2':null,busy,messages,requests:[],hasMore:false });
describe('conversation presentation', () => {
  it('keeps final answers separate from the visible execution process', () => {
    const result = conversationTurns(snapshot([
      {id:'u1',role:'user',text:'One',turnId:'t1',turnStatus:'completed'},
      {id:'c1',role:'assistant',text:'Progress',phase:'commentary',turnId:'t1',turnStatus:'completed'},
      {id:'f1',role:'assistant',text:'Result one',phase:'final',turnId:'t1',turnStatus:'completed'},
      {id:'u2',role:'user',text:'Two',turnId:'t2',turnStatus:'inProgress'},
      {id:'r2',role:'assistant',text:'Visible summary',phase:'reasoning',turnId:'t2',turnStatus:'inProgress'}
    ],true));
    expect(result[0].results.map(m=>m.id)).toEqual(['f1']); expect(result[0].process.map(m=>m.id)).toEqual(['c1']);
    expect(result[1].process.map(m=>m.id)).toEqual(['r2']); expect(result[1].status).toBe('inProgress');
  });
  it('does not promote an interrupted commentary into a final answer', () => {
    const [turn] = conversationTurns(snapshot([{id:'c',role:'assistant',text:'Still working',phase:'commentary',turnId:'t',turnStatus:'interrupted'}]));
    expect(turn.results).toEqual([]); expect(turn.process).toHaveLength(1); expect(turn.status).toBe('interrupted');
  });
  it('supports older helpers without turn metadata', () => {
    const turns = conversationTurns(snapshot([{id:'u',role:'user',text:'Hello'},{id:'c',role:'assistant',text:'Progress'},{id:'f',role:'assistant',text:'Answer'}]));
    expect(turns[0].results[0].text).toBe('Answer'); expect(turns[0].process).toHaveLength(1);
  });
  it('projects only visible reasoning summaries and preserves phase metadata', () => {
    const actual = normalizeSnapshot({ id:'task',turns:[{turnId:'t',status:'completed',items:[
      {id:'r',type:'reasoning',summary:['Visible summary'],content:['Private/raw content']},
      {id:'c',type:'agentMessage',phase:'commentary',text:'Progress'},
      {id:'f',type:'agentMessage',phase:'final',text:'Answer'}
    ]}]},'epoch');
    expect(actual.messages.map(m=>m.phase)).toEqual(['reasoning','commentary','final']);
    expect(actual.messages.every(m=>m.turnId==='t'&&m.turnStatus==='completed')).toBe(true);
    expect(JSON.stringify(actual)).not.toContain('Private/raw');
  });
});
