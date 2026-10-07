import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const origin = process.env.PLAN_WEB_ORIGIN ?? 'http://127.0.0.1:19975';
async function fixture(page: Page) {
  const task = '12345678-1234-4234-8234-123456789abc';
  const snapshot: any = { id:task,title:'Regression task',epoch:'fixture',busy:false,turnId:null,messages:[],requests:[],hasMore:false,settings:{model:'fixture',effort:'high',mode:'default',permission:'ask',revision:'fixture'} };
  const calls: string[] = []; let changed!: () => void, remove!: () => void;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()); let data = {};
    if (url.pathname === '/api/bootstrap') data = { mode:'mobile' };
    if (url.pathname.startsWith('/api/paired-devices')) data = { devices:[{deviceId:'123456789',name:'Regression',authorized:true,online:true,enabled:true,remembered:true,lastUsed:1,expires:Date.now()+86400000}] };
    if (url.pathname === '/api/notifications') data = { items:[],unread:0 };
    await route.fulfill({json:data});
  });
  await page.routeWebSocket('**/ws/mobile*', socket => {
    changed = () => socket.send(JSON.stringify({type:'changed',conversationIds:[task]}));
    socket.send(JSON.stringify({type:'status',online:true,enabled:true,control:{role:'controller',epoch:'fixture',terminals:[]},subscription:{access:true},client:{available:true,capabilities:['task-mode','permission-settings','attachments']}}));
    socket.onMessage(raw => {
      const frame=JSON.parse(String(raw)); if (!frame.command) return; const command=frame.command; calls.push(command.method);
      let result: any = {};
      if (command.method === 'list') result={conversations:[{id:task,title:'Regression task',cwd:'C:/fixture',updatedAt:1}],hasMore:false};
      if (command.method === 'read') result=snapshot;
      if (command.method === 'upload.begin') result={id:frame.id,name:command.params.name,size:command.params.size,mediaType:'text/plain',offset:command.params.size,ready:true};
      if (command.method === 'upload.complete') result={id:command.params.attachmentId,name:'draft.txt',size:3,mediaType:'text/plain',offset:3,ready:true};
      const reply=()=>socket.send(JSON.stringify({type:'result',id:frame.id,result}));
      if (command.method === 'upload.remove') remove=reply; else reply();
    });
  });
  await page.goto(origin); await page.getByRole('button',{name:'Regression task',exact:true}).click();
  await expect(page.getByLabel('消息',{exact:true})).toBeVisible();
  return {snapshot,calls,changed:()=>changed(),remove:()=>remove()};
}
for (const width of [320,390]) {
  test(`modal focus stays in the dialog and restores its trigger at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({width,height:844}); await fixture(page);
    const trigger=page.locator('.permission-status'); await trigger.focus(); await trigger.click();
    const dialog=page.getByRole('dialog',{name:'任务权限',exact:true}); await expect(dialog).toBeVisible();
    for (let i=0;i<16;i++) {
      await page.keyboard.press(i%2?'Tab':'Shift+Tab');
      expect(await dialog.evaluate(element=>element.contains(document.activeElement))).toBe(true);
    }
    await page.getByLabel('消息',{exact:true}).evaluate(element=>(element as HTMLElement).focus());
    expect(await dialog.evaluate(element=>element.contains(document.activeElement))).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath('modal-focus.png')});
    await page.getByTitle('关闭任务权限',{exact:true}).click(); await expect(trigger).toBeFocused();
  });
}
test('a worker fallback opens a separate page and keeps draft attachments intact', async ({page}) => {
  await fixture(page); await page.getByLabel('消息',{exact:true}).fill('Unsent draft');
  await page.locator('input[data-attachment-source="files"]').setInputFiles({name:'draft.txt',mimeType:'text/plain',buffer:Buffer.from('abc')});
  await expect(page.getByText('已上传',{exact:true})).toBeVisible();
  const worker=readFileSync('web/public/sw.js','utf8'); const destination=origin+'/?notification=11111111-1111-4111-8111-111111111111&notificationDevice=123456789';
  const handlers: Record<string, any>={}; let navigated=false, opened='';
  const current={url:origin+'/',focused:false,focus:async()=>current,postMessage:()=>{},navigate:async()=>{navigated=true;return current;}};
  const self={location:{origin},addEventListener:(name:string,handler:any)=>handlers[name]=handler,clients:{matchAll:async()=>[current],openWindow:async(url:string)=>{opened=url;}},registration:{}};
  new Function('self',worker)(self); let completed!: Promise<void>;
  handlers.notificationclick({notification:{close(){},data:{url:destination}},waitUntil:(promise:Promise<void>)=>completed=promise}); await completed;
  expect(navigated).toBe(false); expect(opened).toBe(destination);
  await expect(page.locator('.pending-attachment')).toHaveCount(1); await expect(page.getByLabel('消息',{exact:true})).toHaveValue('Unsent draft');
});
test('attachment removal blocks sending and right clicking never dispatches a message', async ({page}) => {
  const f=await fixture(page); const input=page.getByLabel('消息',{exact:true}),send=page.getByTitle('发送消息',{exact:true});
  await input.fill('Draft'); await expect(send).toBeEnabled(); await send.click({button:'right'}); expect(f.calls.includes('send')).toBe(false);
  await page.locator('input[data-attachment-source="files"]').setInputFiles({name:'draft.txt',mimeType:'text/plain',buffer:Buffer.from('abc')});
  await expect(page.getByText('已上传',{exact:true})).toBeVisible(); await page.getByTitle('移除附件',{exact:true}).click();
  await expect(send).toBeDisabled(); f.remove(); await expect(page.locator('.pending-attachment')).toHaveCount(0); await expect(send).toBeEnabled();
});
test('an authoritative complete snapshot removes obsolete transcript rows', async ({page}) => {
  const f=await fixture(page); f.snapshot.messages=[{id:'old',role:'assistant',text:'Obsolete answer'}]; f.changed();
  await expect(page.getByText('Obsolete answer',{exact:true})).toBeVisible();
  f.snapshot.messages=[{id:'new',role:'assistant',text:'Current answer'}]; f.changed();
  await expect(page.getByText('Current answer',{exact:true})).toBeVisible(); await expect(page.getByText('Obsolete answer',{exact:true})).toHaveCount(0);
});
