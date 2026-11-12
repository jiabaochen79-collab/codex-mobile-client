import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { DesktopActivity, rolloutPath } from '../src/agent/activity.js';
import { catalogModels, threadSettings, validateModel } from '../src/agent/models.js';
describe('task activity and model metadata',()=>{
  let dir:string;beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'remote-activity-'));});afterEach(()=>rmSync(dir,{recursive:true,force:true}));
  it('streams compressed history without retaining large message bodies and prefers the resumed plain file', async () => {
    const file = join(dir, 'compressed.jsonl'), activity = new DesktopActivity(dir);
    const events = [
      { type: 'event_msg', timestamp: 'finished', payload: { type: 'task_complete', turn_id: 'done', last_agent_message: '中'.repeat(3 * 1024 * 1024) } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } }
    ];
    writeFileSync(file + '.zst', zstdCompressSync(Buffer.from(events.map(event => JSON.stringify(event)).join('\n'))));
    expect(rolloutPath(file)).toBe(file + '.zst');
    const first = activity.read(file); expect(first.completionId).toBe('');
    const saved = await activity.readAsync(file);
    expect(saved).toMatchObject({ completionId: 'done:finished', pending: true });
    expect(activity.read(file)).toBe(saved);
    writeFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: 'resumed', payload: { type: 'task_complete', turn_id: 'next' } }) + '\n');
    expect(rolloutPath(file)).toBe(file);
    expect(await activity.readAsync(file)).toMatchObject({ completionId: 'next:resumed', pending: false });
  });
  it('rejects damaged compressed history and retries after it is replaced', async () => {
    const file = join(dir, 'damaged.jsonl'), activity = new DesktopActivity(dir);
    writeFileSync(file + '.zst', 'not zstd');
    await expect(activity.readAsync(file)).rejects.toThrow();
    writeFileSync(file + '.zst', zstdCompressSync(Buffer.from(JSON.stringify({ type: 'event_msg', timestamp: 'now', payload: { type: 'task_failed', turn_id: 'failed' } }) + '\n')));
    expect(await activity.readAsync(file)).toMatchObject({ completionId: 'failed:now', pending: false });
  });
  it('tracks completion identity without treating unfinished history as live activity',()=>{
    const file=join(dir,'task.jsonl');const activity=new DesktopActivity(dir);
    writeFileSync(file,JSON.stringify({type:'event_msg',payload:{type:'task_started',turn_id:'turn-1'}})+'\n');
    expect(activity.read(file)).not.toHaveProperty('running'); expect(activity.read(file).completionId).toBe('');
    appendFileSync(file,JSON.stringify({timestamp:'now',type:'event_msg',payload:{type:'task_complete',turn_id:'turn-1'}})+'\n');
    writeFileSync(join(dir,'.codex-global-state.json'),JSON.stringify({'electron-persisted-atom-state':{'unread-thread-ids-by-host-v1':{local:['task']}}}));
    const state=activity.read(file);expect(state.completionId).toBe('turn-1:now');expect(activity.isUnread('task',state.completionId)).toBe(true);
    activity.markSeen('task',state.completionId);expect(activity.isUnread('task',state.completionId)).toBe(false);
    activity.changed('task',true);expect(activity.isUnread('task','next-turn')).toBe(true);
  });
  it('keeps the last completion when later item events or an unfinished turn remain in the file',()=>{
    const file=join(dir,'orphaned.jsonl');const activity=new DesktopActivity(dir);
    writeFileSync(file,[{timestamp:'finished',type:'event_msg',payload:{type:'task_complete',turn_id:'done'}},{timestamp:'later',type:'event_msg',payload:{type:'item_completed',turn_id:'done'}},{timestamp:'old-start',type:'event_msg',payload:{type:'task_started',turn_id:'orphan'}},{timestamp:'old-input',type:'event_msg',payload:{type:'item_completed',turn_id:'orphan'}}].map(e=>JSON.stringify(e)).join('\n'));
    expect(activity.read(file).completionId).toBe('done:finished');expect(activity.read(file)).not.toHaveProperty('running');
  });
  it('does not export model instructions or invent unsupported effort levels',()=>{
    const models=catalogModels({models:[{slug:'fixture-model',display_name:'Fixture',visibility:'list',default_reasoning_level:'medium',supported_reasoning_levels:[{effort:'medium'},{effort:'high'}]},{slug:'hidden',display_name:'Hidden',visibility:'hide',default_reasoning_level:'low',supported_reasoning_levels:[]}]});
    expect(models).toHaveLength(1);expect(()=>validateModel(models,'fixture-model','ultra')).toThrow();expect(validateModel(models,'fixture-model','high').id).toBe('fixture-model');
  });
  it('matches the native catalog visibility, labels, and priority order',()=>{
    const models=catalogModels({models:[
      {slug:'later',display_name:'GPT-5.5',visibility:'list',priority:12,default_reasoning_level:'low',supported_reasoning_levels:[{effort:'low'}]},
      {slug:'hidden',display_name:'Hidden',visibility:'hide',priority:1,default_reasoning_level:'low',supported_reasoning_levels:[{effort:'low'}]},
      {slug:'first',display_name:'GPT-6-Astra',visibility:'list',priority:1,default_reasoning_level:'medium',supported_reasoning_levels:[{effort:'medium'}]}
    ]});
    expect(models.map(model=>[model.id,model.name])).toEqual([['first','6 Astra'],['later','5.5']]);
  });
  it('revisions change when native next-turn settings change',()=>{
    const state={latestModel:'old',latestReasoningEffort:'low',latestThreadSettings:{model:'new',effort:'high'}};
    expect(threadSettings(state)).toMatchObject({model:'new',effort:'high'});const first=threadSettings(state).revision;state.latestThreadSettings.effort='low';expect(threadSettings(state).revision).not.toBe(first);
  });
  it('normalizes built-in permission profiles and includes native permission changes in the revision',()=>{
    const state:any={latestThreadSettings:{model:'fixture',effort:'high',activePermissionProfile:{id:':workspace',extends:null},sandboxPolicy:{type:'workspaceWrite',writableRoots:['C:/fixture'],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false},approvalPolicy:'on-request',approvalsReviewer:'user'}};
    const ask=threadSettings(state);expect(ask.permission).toBe('ask');
    state.latestThreadSettings.approvalsReviewer='guardian_subagent';const approve=threadSettings(state);expect(approve.permission).toBe('approve');expect(approve.revision).not.toBe(ask.revision);
    state.latestThreadSettings={...state.latestThreadSettings,activePermissionProfile:{id:':danger-full-access',extends:null},sandboxPolicy:{type:'dangerFullAccess'},approvalPolicy:'never',approvalsReviewer:'user'};
    expect(threadSettings(state).permission).toBe('full');
    state.latestThreadSettings.activePermissionProfile={id:'company-policy',extends:':workspace'};expect(threadSettings(state).permission).toBe('custom');
    state.latestThreadSettings.activePermissionProfile=null;state.latestThreadSettings.sandboxPolicy={type:'workspaceWrite'};state.latestThreadSettings.approvalPolicy='on-request';expect(threadSettings(state).permission).toBe('ask');
  });
});
