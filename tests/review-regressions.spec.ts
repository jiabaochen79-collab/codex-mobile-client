import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mockPairedBrowser } from './paired-browser-fixture';

const origin='http://127.0.0.1:18890';
const mount=(kind:string)=>origin+'/@fs/'+fileURLToPath(new URL('./component-harness.html',import.meta.url)).replaceAll('\\','/')+'?component='+kind;
const catalog={plans:[],salesOpen:false,termsVersion:'fixture',supportContact:'fixture'};

for(const method of ['online','manual'])test(`recovers a failed cold bootstrap by ${method} without reloading`,async({page})=>{
  let healthy=false;let calls=0;
  await page.route('**/api/bootstrap',route=>{calls++;return healthy?route.fulfill({json:{mode:'mobile'}}):route.abort('failed');});
  await page.route('**/api/paired-devices**',route=>route.fulfill({json:{devices:[]}}));
  await page.goto(origin);await expect(page.locator('.startup')).toContainText('网络暂时不可用');
  healthy=true;
  if(method==='manual')await page.getByRole('button',{name:'重试',exact:true}).click();
  else await page.evaluate(()=>{window.dispatchEvent(new Event('online'));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));document.dispatchEvent(new Event('visibilitychange'));});
  await expect(page.locator('.startup')).toHaveCount(0);await expect(page.getByRole('heading',{name:'连接电脑',exact:true})).toBeVisible();
  expect(calls).toBe(3);await page.waitForTimeout(1200);expect(calls).toBe(3);
});
test('bounds unattended bootstrap retries and permits a fresh recovery attempt',async({page})=>{
  await page.clock.install();let calls=0;let healthy=false;
  await page.route('**/api/bootstrap',route=>{calls++;return route.fulfill(healthy?{json:{mode:'mobile'}}:{status:400,json:{error:{message:'fixture offline'}}});});
  await page.route('**/api/paired-devices**',route=>route.fulfill({json:{devices:[]}}));
  await page.goto(origin);await expect(page.locator('.startup')).toContainText('fixture offline');
  for(const delay of [1100,3100,10100]){await page.clock.runFor(delay);await expect(page.locator('.startup')).toContainText('fixture offline');}
  expect(calls).toBe(4);await page.clock.runFor(60000);expect(calls).toBe(4);
  healthy=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.locator('.startup')).toHaveCount(0);expect(calls).toBe(5);
});

test('does not report a browser subscription enabled until the current computer binding is verified',async({page})=>{
  let active=false;let writes=0;
  await page.addInitScript(()=>{
    const subscription={endpoint:'https://fcm.googleapis.com/shared-browser',toJSON:()=>({endpoint:'https://fcm.googleapis.com/shared-browser',keys:{p256dh:'p'.repeat(32),auth:'a'.repeat(16)}})};
    const registration={active:{},pushManager:{getSubscription:async()=>subscription}};
    Object.defineProperty(navigator.serviceWorker,'getRegistration',{value:async()=>registration});
    Object.defineProperty(navigator.serviceWorker,'ready',{value:Promise.resolve(registration)});
    Object.defineProperty(Notification,'permission',{value:'granted'});
  });
  await page.route('**/api/notifications/settings',route=>route.fulfill({json:{settings:{enabled:true,completed:true,failed:true},pushConfigured:true,vapidPublicKey:'fixture'}}));
  await page.route('**/api/notifications',route=>route.fulfill({json:{items:[],unread:0}}));
  await page.route('**/api/push/subscriptions/status',route=>{expect(route.request().headers()['x-remote-device']).toBe('123456789');return route.fulfill({json:{active,...(active?{id:'fixture'}:{})}});});
  await page.route('**/api/push/subscriptions',route=>{writes++;active=true;return route.fulfill({json:{id:'fixture',pushConfigured:true}});});
  await page.goto(mount('notifications'));await expect(page.getByRole('button',{name:'开启系统通知',exact:true})).toBeVisible();
  await expect(page.getByText('系统推送已开启。',{exact:true})).toHaveCount(0);expect(writes).toBe(0);
  await page.getByRole('button',{name:'开启系统通知',exact:true}).click();await expect(page.locator('.notification-success')).toHaveText('系统推送已开启。');expect(writes).toBe(1);
  await page.reload();await expect(page.locator('.notification-success')).toHaveText('系统推送已开启。');expect(writes).toBe(1);
  active=false;await page.reload();await expect(page.getByRole('button',{name:'开启系统通知',exact:true})).toBeVisible();expect(writes).toBe(1);
});

test('keeps the server-wide unread count through pagination, duplicate events and reading one item',async({page})=>{
  const row=(id:string)=>({id,deviceId:'123456789',taskId:id,turnId:id,status:'completed',occurredAt:Date.now(),createdAt:Date.now(),readAt:null,delivery:'accepted'});
  let pages=0;
  await page.route('**/api/notifications/settings',route=>route.fulfill({json:{settings:{enabled:true,completed:true,failed:true},pushConfigured:false}}));
  await page.route('**/api/notifications?cursor=*',route=>{pages++;return route.fulfill({json:{items:[row('a'),row('b')],unread:75,nextCursor:null}});});
  await page.route('**/api/notifications',route=>route.fulfill({json:{items:[row('a')],unread:75,nextCursor:'fixture-cursor'}}));
  await page.route('**/api/notifications/*/read',route=>route.fulfill({json:{ok:true,unread:75}}));
  await page.goto(mount('notifications'));await expect(page.locator('#unread')).toHaveText('75');
  await page.getByRole('button',{name:'加载更多提醒',exact:true}).click();await expect(page.locator('.notification-item')).toHaveCount(2);expect(pages).toBe(1);
  await expect(page.locator('#unread')).toHaveText('75');
  await page.evaluate(item=>{for(let i=0;i<2;i++)window.dispatchEvent(new CustomEvent('remote-notification',{detail:item}));},row('c'));
  await expect(page.locator('#unread')).toHaveText('76');await expect(page.locator('.notification-item')).toHaveCount(3);
  await page.locator('.notification-item').first().click();await expect(page.locator('#closed')).toBeVisible();await expect(page.locator('#unread')).toHaveText('75');
});

for(const kind of ['pay','orders'])test(`clears ${kind} polling errors after a successful read`,async({page})=>{
  let healthy=false;let reads=0;
  await page.route(kind==='pay'?'**/api/payments/session?orderId=*':'**/api/orders',route=>{
    if(!healthy)return route.fulfill({status:400,json:{error:{code:'TEMP',message:'fixture interrupted'}}});
    reads++;
    return route.fulfill({json:kind==='pay'?{order:{id:'fixture',deviceId:'123456789',planName:'Month',days:30,priceFen:600,status:'paid',serviceStatus:'active',channel:'alipay',expires:Date.now()+100000},readiness:{ready:true,reason:''}}:{orders:[],licenses:[],refunds:[],readiness:{ready:true,channels:['alipay']}}});
  });
  await page.route('**/api/subscription',route=>route.fulfill({json:{catalog,subscription:{access:true}}}));
  await page.goto(mount(kind)+'&order=fixture');await expect(page.getByRole('alert')).toContainText('fixture interrupted');healthy=true;
  await expect.poll(()=>reads,{timeout:12000}).toBeGreaterThan(0);await expect(page.getByRole('alert')).toHaveCount(0);
  if(kind==='pay')await expect(page.locator('.purchase-state')).toContainText('已支付');
});
test('preserves explicit payment operation errors across successful background reads',async({page})=>{
  await page.route('**/api/orders',route=>route.fulfill({json:{orders:[{id:'fixture',deviceId:'123456789',planName:'Month',priceFen:600,status:'pending',created:Date.now()}],licenses:[],refunds:[],readiness:{ready:true,channels:['alipay']}}}));
  await page.route('**/api/orders/fixture/open',route=>route.fulfill({status:400,json:{error:{code:'INVALID',message:'fixture payment declined'}}}));
  await page.route('**/api/subscription',route=>route.fulfill({json:{catalog,subscription:{access:true}}}));
  await page.goto(mount('orders'));await page.getByTitle('打开付款',{exact:true}).click();await expect(page.getByRole('alert')).toContainText('fixture payment declined');
  await page.waitForTimeout(5500);await expect(page.getByRole('alert')).toContainText('fixture payment declined');
});

test('serializes feedback selection and preserves the reply for the selected ticket',async({page})=>{
  const rows=['ticket-a','ticket-b'].map(id=>({id,category:'connection',state:'open',updated:Date.now()}));
  let release!:()=>void;let requested=false;const gate=new Promise<void>(resolve=>release=resolve);
  await page.route('**/api/feedback**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/read'))return route.fulfill({json:{ok:true}});
    if(path==='/api/feedback')return route.fulfill({json:{rows,total:rows.length}});
    const id=path.split('/').at(-1);if(id==='ticket-a'){requested=true;await gate;}
    return route.fulfill({json:{ticket:{id,state:'open'},messages:[{id:id+'-message',seq:1,actor:'user',text:'Message for '+id,images:[],created:Date.now()}]}});
  });
  await page.goto(mount('feedback'));await page.locator('.feedback-list button').filter({hasText:'ticket-a'}).click();await expect.poll(()=>requested).toBe(true);
  await expect(page.locator('.feedback-list button').filter({hasText:'ticket-b'})).toBeDisabled();await expect(page.getByTitle('关闭反馈',{exact:true})).toBeDisabled();
  release();await expect(page.locator('.feedback-thread')).toContainText('ticket-a');await expect(page.getByTitle('返回反馈列表',{exact:true})).toBeEnabled();
  await page.getByTitle('返回反馈列表',{exact:true}).click();await page.locator('.feedback-list button').filter({hasText:'ticket-b'}).click();
  const input=page.getByLabel('补充信息',{exact:true});await expect(input).toBeEnabled();await input.fill('Reply for B');await page.waitForTimeout(200);
  await page.getByTitle('返回反馈列表',{exact:true}).click();await page.locator('.feedback-list button').filter({hasText:'ticket-b'}).click();await expect(input).toHaveValue('Reply for B');
});
for(const kind of ['subscription','orders'])test(`${kind} closes only explicitly and preserves form inputs after backdrop and Escape`,async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.route('**/api/subscription',route=>route.fulfill({json:{catalog,subscription:{access:true}}}));
  await page.route('**/api/orders',route=>route.fulfill({json:{orders:[],licenses:[],refunds:[],readiness:{ready:true,channels:['alipay']}}}));
  await page.goto(mount(kind));
  const input=page.getByLabel('授权码',{exact:true});if(kind==='subscription')await input.fill('CM-unsent-fixture');
  await page.locator('.modal-backdrop').click({position:{x:2,y:2}});await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toBeVisible();
  if(kind==='subscription')await expect(input).toHaveValue('CM-unsent-fixture');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`.runtime/review-fixes/modal-${kind}.png`});
  await page.getByTitle(kind==='subscription'?'关闭订阅':'关闭订单',{exact:true}).click();await expect(page.locator('#closed')).toBeVisible();
});

async function chatFixture(page:Page){
  const conversations=[{id:'11111111-1111-4111-8111-111111111111',title:'Task A',cwd:'C:/fixture',updatedAt:1},{id:'22222222-2222-4222-8222-222222222222',title:'Task B',cwd:'C:/fixture',updatedAt:2}];
  let hold=false;let pendingRead=0;const held:(()=>void)[]=[];const commands:any[]=[];
  await mockPairedBrowser(page);
  await page.route('**/api/bootstrap',route=>route.fulfill({json:{mode:'mobile'}}));
  await page.route('**/api/notifications',route=>route.fulfill({json:{items:[],unread:0}}));
  await page.routeWebSocket('**/ws/mobile*',socket=>{
    socket.send(JSON.stringify({type:'status',online:true,enabled:true,subscription:{access:true},client:{available:true,capabilities:['task-mode','multi-terminal']},control:{role:'controller',epoch:'33333333-3333-4333-8333-333333333333',terminals:[]}}));
    socket.onMessage(raw=>{const frame=JSON.parse(String(raw));commands.push(frame.command);const command=frame.command;const task=conversations.find(row=>row.id===command.params.id);
      const result=command.method==='list'?{conversations,hasMore:false}:command.method==='read'?{...task,epoch:'fixture',busy:false,turnId:null,requests:[],messages:[],hasMore:false,settings:{mode:'default',revision:'fixture'}}:{accepted:true};
      const reply=()=>socket.send(JSON.stringify({type:'result',id:frame.id,result}));if(command.method==='read'&&hold){pendingRead++;held.push(reply);}else reply();
    });
  });
  await page.goto(origin);await page.getByRole('button',{name:'Task A',exact:true}).click();await expect(page.getByLabel('消息',{exact:true})).toBeEnabled();
  return{commands,hold:()=>{hold=true;},pending:()=>pendingRead,release:()=>{hold=false;held.splice(0).forEach(reply=>reply());}};
}
test('retains a new draft when an earlier send refresh finishes after changing tasks',async({page})=>{
  const state=await chatFixture(page);const input=page.getByLabel('消息',{exact:true});await input.fill('Submitted message');state.hold();
  await page.getByTitle('发送消息',{exact:true}).click();await expect.poll(state.pending).toBeGreaterThan(0);await expect(input).toBeEnabled();await expect(input).toHaveValue('');
  await input.fill('New draft for A');await page.getByTitle('项目与会话',{exact:true}).click();await page.getByRole('button',{name:'Task B',exact:true}).click();await expect(page.locator('.chat-heading h1')).toHaveText('Task B');
  state.release();await page.waitForTimeout(200);await page.getByTitle('项目与会话',{exact:true}).click();await page.getByRole('button',{name:'Task A',exact:true}).click();
  await expect(input).toHaveValue('New draft for A');expect(state.commands.filter(command=>command.method==='send')).toHaveLength(1);
});
test('rejects a header-only image using the actual browser decoder',async({page})=>{
  await page.route('**/api/bootstrap',route=>route.fulfill({json:{mode:'mobile'}}));await page.route('**/api/paired-devices**',route=>route.fulfill({json:{devices:[]}}));await page.goto(origin);
  const message=await page.evaluate(async()=>{const path='/prepare-photo.ts';const {preparePhoto}=await import(path);try{await preparePhoto(new File([new Uint8Array([137,80,78,71,13,10,26,10])],'broken.png',{type:'image/png'}),true);return 'accepted';}catch(e){return (e as Error).message;}});
  expect(message).toContain('图片损坏');
});
