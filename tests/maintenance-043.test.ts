import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { parse, compileScript } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import ts from 'typescript';
import { it, afterEach, afterAll, vi } from 'vitest';
import * as commerce from '../src/shared/commerce.js';
import * as subscription from '../src/shared/subscription.js';
import * as feedback from '../src/shared/feedback.js';
const root = mkdtempSync(resolve('.runtime/fixes-043-'));
const storage = new Map<string, string>();
afterEach(() => { cleanup(); storage.clear(); vi.restoreAllMocks(); });
afterAll(() => rmSync(root, { recursive: true, force: true }));
import { AgentStore } from '../src/agent/store.js';
import { HelperUpdater } from '../src/agent/updater.js';
import { CompletionMonitor } from '../src/agent/notifications.js';
import { CodexDesktop, normalizeSnapshot } from '../src/agent/desktop.js';
import { DesktopActivity } from '../src/agent/activity.js';
import { SendQueue } from '../src/agent/send-queue.js';
import { api as realApi } from '../web/api.js';
import { conversationTurns } from '../web/conversation-model.js';
let api: (...args: any[]) => Promise<any> = async () => ({});
const mounted: (() => any)[] = [], unmounted: (() => any)[] = [], scopes: vue.EffectScope[] = [];
const noop = () => {};
Object.assign(globalThis, { CSS: { escape: (value: string) => value } });
Object.assign(globalThis, { window: { addEventListener: noop, removeEventListener: noop, dispatchEvent: noop, matchMedia: () => ({ matches: false }) }, document: { visibilityState: 'visible', documentElement: { classList: { toggle: noop, remove: noop } }, querySelector: () => null, addEventListener: noop, removeEventListener: noop }, location: { href: 'http://127.0.0.1/pay/?order=fixture', origin: 'http://127.0.0.1', pathname: '/pay/', search: '?order=fixture', hash: '' }, history: { replaceState: noop, scrollRestoration: 'auto' }, sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }, localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, cancelAnimationFrame: noop, innerWidth: 390, innerHeight: 844, visualViewport: { height: 844, offsetTop: 0 } });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Fixture', platform: 'Fixture', maxTouchPoints: 0 } });
function setup(file: string, props: any = {}) {
  const path = 'web/' + file;
  const code = transformSync(compileScript(parse(readFileSync(path, 'utf8')).descriptor, { id: file }).content, { loader: 'ts', format: 'cjs', define: { 'import.meta.env.PROD': 'true' } }).code;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', code)((id: string) => {
    if (id === 'vue') return { ...vue, onMounted: (fn: any) => mounted.push(fn), onActivated: noop, onDeactivated: noop, onUnmounted: (fn: any) => unmounted.push(fn) };
    if (id.endsWith('/protocol')) return {};
    if (id === './use-chat-scroll') return { useChatScroll: () => ({ awayFromBottom: vue.ref(false), change: async (fn: any) => fn(), reset: noop, pause: noop, resume: noop, layoutChanged: noop }) };
    if (id === './use-attachments') return { useAttachments: () => ({ current: vue.ref([]), hasPending: vue.ref(false), restore: noop, clear: noop }) };
    if (id === './conversation-model') return { conversationTurns };
    if (id === './api') return { api: (...args: any[]) => api(...args) };
    if (id.endsWith('/commerce')) return commerce;
    if (id.endsWith('/subscription')) return subscription;
    if (id.endsWith('/feedback')) return feedback;
    if (id.endsWith('/updates')) return { RELEASE_UPLOAD_CHUNK: 1024 };
    if (id === 'qrcode') return { toDataURL: async () => '' };
    if (id === './resume-reload') return { installResumeReload: () => ({ ready: noop, dispose: noop }) };
    if (id === './notification-count') return { mergeNotificationCount: (_: any, n: any) => n };
    if (id === './push-registration') return { pushRegistration: async () => ({}) };
    if (id === './feedback-drafts') return { feedbackDraft: async () => null };
    if (id === './feedback-upload') return { uploadFeedbackPictures: async (_: any, images: any) => images };
    if (id === 'lucide-vue-next' || id.endsWith('.vue') || id === './prepare-photo' || id === './mobile-viewport') return {};
    throw new Error(id);
  }, module, module.exports);
  const scope = vue.effectScope(); scopes.push(scope);
  return scope.run(() => module.exports.default.setup(props, { expose: noop, emit: noop }));
}
function cleanup() { unmounted.splice(0).forEach(fn => fn()); mounted.length = 0; scopes.splice(0).forEach(scope => scope.stop()); }
function deferred() { let resolve!: (v?: any) => void, reject!: (e?: any) => void; return { promise: new Promise<any>((r,j) => { resolve = r; reject = j; }), resolve, reject }; }
function sourceFunction(file: string, name: string) {
  const raw = readFileSync(file, 'utf8');
  const code = file.endsWith('.vue') ? parse(raw).descriptor.scriptSetup!.content : raw;
  const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find((statement: any) => ts.isFunctionDeclaration(statement) && statement.name?.text === name)!;
  return new Function(transformSync(node.getText(ast).replace(/^export /, '') + '\nreturn ' + name, {loader:'ts',format:'cjs'}).code)();
}
function boundFunction(file: string, name: string, bindings: Record<string, any>) {
  const raw = readFileSync(file, 'utf8');
  const code = file.endsWith('.vue') ? parse(raw).descriptor.scriptSetup!.content : raw;
  const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find((statement: any) => ts.isFunctionDeclaration(statement) && statement.name?.text === name)!;
  return new Function(...Object.keys(bindings), transformSync(node.getText(ast).replace(/^export /, '') + '\nreturn ' + name, {loader:'ts',format:'cjs'}).code)(...Object.values(bindings));
}
it('updater-stale-installer-freeze', async () => {
  const dir = join(root, 'updater'); mkdirSync(join(dir, 'updates'), { recursive: true });
  writeFileSync(join(dir, 'updates/result.json'), JSON.stringify({ version: '0.4.43', phase: 'failed', installerRunning: true, runnerPid: 2147483647 }));
  const store = new AgentStore(dir); let frozen = false, requests = 0;
  const updater = new HelperUpdater({ dir, root: dir + '-program', version: '0.4.42', store, request: async () => { requests++; return new Response('{}'); }, blockers: async () => [], freeze: v => frozen = v });
  await updater.reportPrevious(); await updater.check();
  assert.equal(frozen, false); assert.notEqual(updater.state.phase, 'installing'); assert.ok(requests > 0);
  updater.close(); store.close(); return { frozen, requests };
});
it('clock-rollback-freezes-outbox-retries', async () => {
  const store = new AgentStore(join(root, 'retry-clock')); const now = Date.now();
  const event = { eventId: 'b'.repeat(64), taskId: '11111111-1111-4111-8111-111111111111', turnId: 'retry', status: 'completed' as const, occurredAt: now, protocolVersion: 1 as const };
  store.recordNotification(event, { path: 'retry', offset: 0, mtime: now, size: 0, fileId: 'fixture', baselineAt: now, remainder: '' }); store.markNotificationAttempt(event.eventId);
  assert.equal(store.notificationOutbox(now + 11000).length, 1); assert.equal(store.notificationOutbox(now - 3600000).length, 1);
  store.close(); return { retryDelayAfterClockRollbackMs: 3610000 };
});
it('clock rollback preserves a fresh event time and does not retime pinned historical events', () => {
  const store = new AgentStore(join(root, 'clock')); const origin = 'https://fixture.test'; let local = 1800000000000;
  vi.spyOn(Date, 'now').mockImplementation(() => local);
  store.syncNotificationClock(origin, local, local);
  const cursor = { path: 'clock', offset: 0, mtime: local, size: 0, fileId: '', baselineAt: local, remainder: '' };
  const row = (id: string) => ({ eventId: id, taskId: randomUUID(), turnId: id, status: 'completed' as const, occurredAt: local, protocolVersion: 1 as const });
  store.recordNotification(row('old'), cursor); const pinned = store.notificationTime('old', origin);
  local -= 3600000; store.recordNotification(row('new'), cursor);
  store.syncNotificationClock(origin, local + 3600000, local);
  assert.ok(store.notificationTime('new', origin)! >= local + 3600000);
  assert.equal(store.notificationTime('old', origin), pinned); store.close();
});
it('same-inode-truncate-regrow-skips-completion', async () => {
  const dir = join(root,randomUUID()); mkdirSync(dir,{recursive:true}); const path=join(dir,'rollout.jsonl');
  const store = new AgentStore(dir), task='11111111-1111-4111-8111-111111111111';
  const now=Date.now(); writeFileSync(path,JSON.stringify({type:'fixture',data:'x'.repeat(500)})+'\n');
  const monitor = new CompletionMonitor(store,()=>[{id:task,path}]); monitor.watch(task,now-1000); await monitor.poll();
  writeFileSync(path,JSON.stringify({type:'event_msg',timestamp:new Date(now+1).toISOString(),payload:{type:'task_complete',turn_id:'rewritten'}})+'\n'+JSON.stringify({type:'fixture',data:'x'.repeat(1000)})+'\n');
  await monitor.poll(); assert.equal(store.notificationOutbox().length,1);
  monitor.close(); store.close(); return {completionBeforeCursorWasSkipped:true};
});
it('task-list-cursor-ignores-updated-filter', async () => {
  const dir=join(root,randomUUID()); mkdirSync(dir,{recursive:true}); const path=join(dir,'log.jsonl'); writeFileSync(path,'{}\n');
  const db = new DatabaseSync(join(dir,'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,cwd TEXT,updated_at_ms INTEGER,updated_at INTEGER,project_id TEXT,source TEXT,archived INTEGER,rollout_path TEXT)');
  const insert=db.prepare("INSERT INTO threads VALUES(?,'Matched task','',?, ?,0,?,'vscode',0,?)");
  const ids=Array.from({length:31},()=>randomUUID());
  ids.forEach((id,i)=>insert.run(id,dir,100-i,'project-a',path));
  const adapter = new CodexDesktop('fixture.exe',dir);
  (adapter as any).taskActivity=(id:string)=>({id,running:false,unread:false,completionId:''});
  const projects:any=[{id:'project-a',roots:[dir],nativeIds:['project-a']},{id:'project-b',roots:[dir+'-b'],nativeIds:['project-b']}];
  const first=adapter.list(0,{projectId:'project-a',query:'Matched',cursor:'new'},projects);
  db.prepare("UPDATE threads SET project_id='project-b',cwd=?,name='Not matching any more' WHERE id=?").run(dir+'-b',ids[30]);
  const second=adapter.list(30,{projectId:'project-a',query:'Matched',cursor:first.cursor},projects);
  assert.equal(second.conversations.length,0); assert.equal(second.hasMore,false);
  adapter.close();db.close(); return {requestedProject:'project-a',actualProject:null,requestedSearch:'Matched',actualTitle:null};
});
it('running-task-log-blocks-event-loop', async()=> {
  const dir=join(root,randomUUID()); mkdirSync(dir,{recursive:true}); const path=join(dir,'large.jsonl');
  const start=JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_started',turn_id:'running'}})+'\n';
  const line=JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'x'.repeat(65536)}})+'\n';
  writeFileSync(path,start+line.repeat(1000));
  let returned=false,timerFired=false;
  const timer=setTimeout(()=>timerFired=true,0);const t=performance.now();
  const result=new DesktopActivity(dir).read(path);const blockedMs=performance.now()-t;returned=true;
  assert.ok(blockedMs<50); await new Promise(resolve => setTimeout(resolve, 0));assert.equal(timerFired,true); clearTimeout(timer); const t2=performance.now(); const fresh=await new DesktopActivity(dir).readAsync(path); assert.equal(fresh.pending,true); console.log('64MB activity async scan ms:', Math.round(performance.now()-t2));
  return {blockedMs:Math.round(blockedMs),bytes:line.length*1024,pending:result.pending,timerFired,returned};
});
it('response-body-network-failure-is-swallowed', async()=> {
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return {ok:true,status:200,headers:new Headers({'content-type':'application/json'}),json:async()=>{throw new TypeError('fixture body stream reset');}} as any;};
  try {
    let error:any;try{await realApi('/api/fixture');}catch(e){error=e;}
    assert.equal(calls,2);assert.equal(error.code,'NETWORK'); await assert.rejects(realApi('/api/fixture', {}), (error:any) => error.code==='OUTCOME_UNKNOWN'); assert.equal(calls,3);
    return {calls,errorCode:error.code,networkRetryWasSkipped:true};
  } finally {globalThis.fetch=original;}
});
it('right-click-on-send-dispatches-message', async()=> {
  let sends = 0;
  class FakeElement { closest() { return {disabled:false,classList:{contains:()=>false}}; } }
  const fn=boundFunction('web/MobilePanel.vue','composerPointerdown',{Element:FakeElement,sendFromButton:()=>sends++});
  fn({target:new FakeElement(),button:2,isPrimary:true});
  assert.equal(sends,0); fn({target:new FakeElement(),button:0,isPrimary:true}); assert.equal(sends,1);return {mouseButton:2,sends};
});
it('identical-image-snapshot-restarts-open-preview', async()=> {
  const photo={id:'image-a',alt:'photo',mediaType:'image/jpeg'};
  const props=vue.reactive({conversationId:randomUUID(),images:[photo]});
  const p=setup('MessageImages.vue',props);p.selected.value=props.images[0];p.previewLoaded.value=true;
  for(let i=0;i<3;i++){props.images=[{...photo}];await vue.nextTick();}
  assert.equal(p.previewAttempt.value,0);assert.equal(p.previewLoaded.value,true);
  return {unchangedSnapshots:3,imageRemounts:3,previewLoaded:p.previewLoaded.value};
});
it('notification-task-title-cache-never-refetches', async()=> {
  const id=randomUUID(), cache:any={[id]:{id,title:'Old name'}};let requests=0;
  const state:any={active:vue.ref(true),canRead:vue.ref(true),groups:{},searchRows:vue.ref([]),resolvingNotificationTasks:undefined,notificationTaskChecked:new Map([[id,performance.now()-61000]]),notificationTaskIds:new Set(),notificationTasks:cache,knownNotificationTask:(id:string)=>cache[id],navigationEpoch:0,hasCapability:()=>true,request:async()=>{requests++;return {conversations:[{id,title:'Renamed on desktop'}]};}};
  const fn=boundFunction('web/MobilePanel.vue','resolveNotificationTasks',state);
  await fn([id]);assert.equal(requests,1);assert.equal(cache[id].title,'Renamed on desktop'); await fn([id]);assert.equal(requests,1);
  return {expectedTitle:'Renamed on desktop',actualTitle:cache[id].title,requests};
});
it('desktop-completion-lost-when-task-archived-before-poll', async()=> {
  const dir=join(root,randomUUID());mkdirSync(dir,{recursive:true});const path=join(dir,'rollout.jsonl'),task=randomUUID();
  const db=new DatabaseSync(join(dir,'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,cwd TEXT,updated_at_ms INTEGER,updated_at INTEGER,project_id TEXT,source TEXT,archived INTEGER,rollout_path TEXT)');
  db.prepare("INSERT INTO threads VALUES(?,'task','',?,1,0,NULL,'vscode',0,?)").run(task,dir,path);
  writeFileSync(path,'{}\n');const store=new AgentStore(dir),desktop=new CodexDesktop('fixture.exe',dir);
  const monitor=new CompletionMonitor(store,ids=>desktop.notificationSources(ids));
  await monitor.poll();
  const original=Date.now;const now=Date.now()+6000;Date.now=()=>now;
  try {
    writeFileSync(path,'{}\n'+JSON.stringify({type:'event_msg',timestamp:new Date(now).toISOString(),payload:{type:'task_complete',turn_id:'archived-turn'}})+'\n');
    db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(task);
    await monitor.poll();assert.equal(store.notificationOutbox().length,1);
    const sources=await desktop.notificationSources();assert.equal(sources.length,0);
    return {archivedBeforeNextPoll:true,watchedByMobile:false,outboxEvents:0};
  } finally {Date.now=original;monitor.close();desktop.close();store.close();db.close();}
});
it('clock-rollback-reverses-send-queue-fifo', async()=> {
  const store=new AgentStore(join(root,randomUUID()));
  store.protect=(value:string)=>value;
  const queue=new SendQueue(store,'https://fixture.test'),task=randomUUID(),session=randomUUID();
  const original=Date.now,now=Date.now();
  try {
    Date.now=()=>now;
    queue.add(randomUUID(),task,session,'epoch',{text:'A: first',attachments:[]});
    Date.now=()=>now-3600000;
    queue.add(randomUUID(),task,session,'epoch',{text:'B: second',attachments:[]});
    const order=queue.entries(task).map(row=>queue.payload(row).text);
    assert.deepEqual(order,['A: first','B: second']);
    return {enqueueOrder:['A: first','B: second'],executionOrder:order,dpapiTested:false};
  } finally {Date.now=original;store.close();}
});
it('expired-search-cursor-discards-first-page', async()=> {
  const dir=join(root,randomUUID());mkdirSync(dir,{recursive:true});const path=join(dir,'log.jsonl');writeFileSync(path,'{}\n');
  const db=new DatabaseSync(join(dir,'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,cwd TEXT,updated_at_ms INTEGER,updated_at INTEGER,project_id TEXT,source TEXT,archived INTEGER,rollout_path TEXT)');
  const insert=db.prepare("INSERT INTO threads VALUES(?,'Matched task','',?, ?,0,NULL,'vscode',0,?)");
  Array.from({length:31},()=>randomUUID()).forEach((id,i)=>insert.run(id,dir,100-i,path));
  const desktop=new CodexDesktop('fixture.exe',dir);(desktop as any).taskActivity=(id:string)=>({id,running:false,unread:false,completionId:''});
  const state:any={canRead:vue.ref(true),search:vue.ref('Matched'),searchRevision:0,searchLoading:vue.ref(false),searchError:vue.ref(''),searchRows:vue.ref([]),searchMore:vue.ref(false),projectNavigation:vue.ref(true),hasCapability:()=>true,searchCursor:undefined,searchOffset:0,request:async(command:any)=>desktop.list(command.params.offset,command.params)};
  const search=boundFunction('web/MobilePanel.vue','runSearch',state);
  const original=Date.now,now=Date.now();
  try {
    Date.now=()=>now;await search();assert.equal(state.searchRows.value.length,30);
    Date.now=()=>now+16*60000;await search(true);
    assert.equal(state.searchRows.value.length,30);
    return {initialVisible:30,afterLoadMore:state.searchRows.value.length,cursorExpiryMinutes:15};
  } finally {Date.now=original;desktop.close();db.close();}
});
it('settings-update-remounts-plan-and-drops-feedback', async()=> {
  const task=randomUUID(),turn='plan-turn';
  const state:any={id:task,title:'Plan',latestModel:'gpt-test',turns:[{turnId:turn,status:'completed',items:[{id:'plan',type:'planImplementation'}]}],requests:[{id:'implement-plan:'+turn,method:'item/plan/requestImplementation',params:{threadId:task,turnId:turn,planContent:'Unchanged plan'}}]};
  const before=normalizeSnapshot(state,'epoch');state.latestModel='other-model';const after=normalizeSnapshot(state,'epoch');
  assert.notEqual(before.requests[0].plan?.revision,after.requests[0].plan?.revision);
  const raw=readFileSync('web/MobilePanel.vue','utf8');const key=raw.match(/<PlanRequest[^>]*?:key="([^\"]+)"/)![1];
  const actualKey=new Function('selected','r','return '+key);
  let current:any;const component={props:['request','conversationId','deviceId','disabled','supported'],setup(props:any){current=setup('PlanRequest.vue',props);return ()=>vue.h('div');}};
  const renderer=vue.createRenderer<any,any>({createElement:()=>({children:[]}),createText:(text:string)=>({text}),createComment:()=>({}),setText:noop,setElementText:noop,parentNode:()=>null,nextSibling:()=>null,insert:(el:any,parent:any)=>parent.children.push(el),remove:noop,patchProp:noop});
  const container={children:[]};
  renderer.render(vue.h(component,{key:actualKey({id:task},before.requests[0]),request:before.requests[0],conversationId:task,deviceId:'123456789',disabled:false,supported:true}),container);
  current.editing.value=true;current.feedback.value='Important unsent feedback';const old=current; await vue.nextTick();
  renderer.render(vue.h(component,{key:actualKey({id:task},after.requests[0]),request:after.requests[0],conversationId:task,deviceId:'123456789',disabled:false,supported:true}),container);
  assert.notEqual(current,old);assert.equal(current.feedback.value,'Important unsent feedback');assert.equal(current.editing.value,true);
  renderer.render(null,container);
  return {planContentChanged:false,modelChanged:true,unsentFeedbackAfterUpdate:current.feedback.value};
});
it('activation-success-clears-newly-entered-license', async()=> {
  const p=setup('SubscriptionPanel.vue',{mode:'mobile',deviceId:'123456789'}),pending=deferred();
  p.catalog.value={termsVersion:subscription.TERMS_VERSION};p.accepted.value=true;p.code.value='CM1_'+'a'.repeat(32);
  let submitted:any;api=async(_path:string,body:any)=>{submitted=body;return pending.promise;};
  const activation=p.activate();p.code.value='CM1_'+'b'.repeat(32);
  pending.resolve({catalog:{termsVersion:subscription.TERMS_VERSION},subscription:{access:true},trial:{used:true}});await activation;
  assert.equal(submitted.code,'CM1_'+'a'.repeat(32));assert.equal(p.code.value,'CM1_'+'b'.repeat(32));
  return {submittedOldCode:true,newInputCleared:true};
});
it('background-image-refresh-turns-off-autoscroll', async () => {
  const create = sourceFunction('web/use-chat-scroll.ts','useChatScroll');
  const box:any={scrollHeight:1000,clientHeight:500,clientWidth:390,scrollTop:500,getBoundingClientRect:()=>({top:0}),querySelectorAll:()=>[],querySelector:()=>null};
  let top=500;Object.defineProperty(box,'scrollTop',{get:()=>top,set:value=>{top=Math.min(value,box.scrollHeight-box.clientHeight);}});
  const s = new Function('ref','watch','onUnmounted','nextTick','return '+create.toString())(vue.ref,noop,noop,vue.nextTick)(vue.ref(box),vue.ref(undefined));
  s.toBottom(); box.scrollTop=500;
  await s.change(noop,'preserve'); await s.change(()=>{box.scrollHeight=1500},'auto');
  assert.equal(box.scrollTop,1000); assert.equal(s.awayFromBottom.value,false); return {scrollTop:box.scrollTop,latestBottom:1000};
});
it('payment-poller-created-after-unmount', async () => {
  const pending = deferred(); let timers = 0; const oldSet = globalThis.setInterval, oldClear = globalThis.clearInterval;
  globalThis.setInterval = (() => { timers++; return 1; }) as any; globalThis.clearInterval = ((id: any) => { if (id) timers--; }) as any;
  try {
    api = async () => pending.promise; setup('PayApp.vue'); const start = mounted.shift()!(); cleanup();
    pending.resolve({ order: { status: 'pending' }, readiness: { ready: true } }); await start;
    assert.equal(timers, 0); return { orphanTimers: timers };
  } finally { globalThis.setInterval = oldSet; globalThis.clearInterval = oldClear; }
});
it('desktop-poller-created-after-unmount', async () => {
  const pending = deferred(); let timers = 0; const oldSet = globalThis.setInterval, oldClear = globalThis.clearInterval;
  globalThis.setInterval = (() => { timers++; return 1; }) as any; globalThis.clearInterval = ((id: any) => { if (id) timers--; }) as any;
  try {
    api = async () => pending.promise; setup('DesktopPanel.vue'); const start = mounted.shift()!(); cleanup(); pending.resolve({}); await start;
    assert.equal(timers, 0); return { orphanTimers: timers };
  } finally { globalThis.setInterval = oldSet; globalThis.clearInterval = oldClear; }
});
it('expired-notifications-retained-after-resume', async () => {
  const id = randomUUID(); const taskId = randomUUID();
  const p = setup('NotificationCenter.vue', { deviceId:'123456789', resolveTasks:async()=>{}, openTask:async()=>true, taskLabels:{} });
  const expired = {id,deviceId:'123456789',taskId,turnId:'expired',sequence:1,status:'completed',occurredAt:1,createdAt:1,expiresAt:2,readAt:null};
  api = async (path:string) => path.includes('settings') ? {settings:{enabled:false,completed:true,failed:true},revision:'x'} : {items:[expired],unread:1,throughSequence:1,nextCursor:null};
  await p.load();
  api = async (path:string) => path.includes('settings') ? {settings:{enabled:false,completed:true,failed:true},revision:'x'} : {items:[],unread:0,throughSequence:1,nextCursor:null};
  await p.load(true);
  assert.equal(p.items.value.length,0); assert.equal(p.unread.value,0);
  return {expiredRowsStillShown:p.items.value.length,serverRows:0};
});
it('complete snapshots remove withdrawn messages but partial history retains older messages', () => {
  const merge = sourceFunction('web/MobilePanel.vue','mergeMessages');
  const previous = [{id:'older',role:'user',text:'earlier'}, {id:'withdrawn',role:'assistant',text:'obsolete'}];
  const incoming = [{id:'current',role:'assistant',text:'answer'}];
  assert.deepEqual(merge(previous,incoming,true),incoming);
  assert.equal(merge(previous,incoming,false).length,3);
});
