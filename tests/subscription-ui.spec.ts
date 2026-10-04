import { test, expect } from '@playwright/test';
import { mockPairedBrowser } from './paired-browser-fixture';
import { PLANS, TERMS_VERSION, type Catalog, type Subscription } from '../src/shared/subscription';

test.use({ viewport: { width: 390, height: 844 }, launchOptions: process.env.TEST_BROWSER === 'webkit' ? {} : { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
const origin='http://127.0.0.1:18890';
const taskId='12345678-1234-4234-8234-123456789abc';
const catalog:Catalog={salesOpen:false,operatorName:'',supportContact:'',termsVersion:TERMS_VERSION,plans:PLANS.map(p=>({...p,available:p.id==='trial',reason:p.id==='trial'?'':'尚未开放购买'})),limits:{computers:1,terminals:3,controllers:1,mediaBps:3000000,fileBytes:25*1024**2,attachmentCount:5,attachmentBytes:50*1024**2,trafficQuota:null,autoRenew:false}};
function subscription(active=false):Subscription{return{mode:'licensed',status:active?'active':'unlicensed',access:active,expiresAt:active?Date.now()+86400000:null,planId:active?'month':null,serverTime:Date.now(),revision:active?'active':'unlicensed',termsVersion:TERMS_VERSION};}

test('shows all prices and limits before purchase without exposing an activation form to guests',async({page},info)=>{
  await page.route('**/api/session',r=>r.fulfill({status:401,json:{error:{message:'Not paired'}}}));await page.route('**/api/plans',r=>r.fulfill({json:catalog}));
  await page.goto(origin);await page.getByRole('button',{name:'订阅与权益',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'订阅与权益',exact:true});await expect(panel).toContainText('¥6');await expect(panel).toContainText('¥15');await expect(panel).toContainText('¥50');
  await expect(panel).toContainText('购买暂未开放');await expect(panel).toContainText('不属于端到端加密');await expect(panel).toContainText('最高 3Mbps');await expect(panel.getByLabel('授权码',{exact:true})).toHaveCount(0);
  for(const width of [320,390,900]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath(`subscription-${width}.png`)});}
});

test('requires consent for activation and keeps device pairing separate from payment',async({page})=>{
  let current=subscription();let submitted:any;const commands:string[]=[];
  await mockPairedBrowser(page);
  await page.route('**/api/subscription',r=>r.fulfill({json:{subscription:current,catalog}}));
  await page.route('**/api/subscription/redeem',r=>{submitted=r.request().postDataJSON();current=subscription(true);return r.fulfill({json:{subscription:current,catalog}});});
  await page.routeWebSocket('**/ws/mobile*',ws=>{ws.send(JSON.stringify({type:'status',online:true,enabled:true,client:{available:true,capabilities:[]},subscription:current}));ws.onMessage(data=>{const frame=JSON.parse(String(data));commands.push(frame.command.method);ws.send(JSON.stringify({type:'result',id:frame.id,result:frame.command.method==='list'?{conversations:[],hasMore:false}:{accepted:true}}));});});
  await page.goto(origin);await page.getByRole('button',{name:'订阅未开通或已到期',exact:false}).click();
  const panel=page.getByRole('dialog',{name:'订阅与权益',exact:true});
  await page.setViewportSize({width:390,height:640});
  await expect(panel.getByLabel('授权码',{exact:true})).toBeInViewport();
  const code='CM1_'+'a'.repeat(32);await panel.getByLabel('授权码',{exact:true}).fill(code);
  await expect(panel.getByRole('button',{name:'激活授权',exact:true})).toBeDisabled();expect(commands).not.toContain('list');
  await panel.getByRole('checkbox').check();await panel.getByRole('button',{name:'激活授权',exact:true}).click();
  await expect(panel.getByText('授权已激活',{exact:true})).toBeVisible();expect(submitted).toEqual({code,termsVersion:TERMS_VERSION});await expect(panel.getByLabel('授权码',{exact:true})).toHaveValue('');
  expect(commands).not.toContain('control.claim');
});

test('shows an available trial for a paired device and keeps the subscription modal inside the viewport',async({page})=>{
  let current=subscription(); let trial={available:true,reason:'',used:false,enabled:true,days:7 as const}; let submitted:any;
  await mockPairedBrowser(page);
  await page.route('**/api/subscription',r=>r.fulfill({json:{subscription:current,catalog,trial}}));
  await page.route('**/api/subscription/trial',r=>{submitted=r.request().postDataJSON(); current={...subscription(true),status:'trial'}; trial={available:false,reason:'此电脑或客户已领取试用或购买订阅。',used:true,enabled:true,days:7}; return r.fulfill({json:{subscription:current,catalog,trial}});});
  await page.routeWebSocket('**/ws/mobile*',ws=>{ws.send(JSON.stringify({type:'status',online:true,enabled:true,client:{available:true,capabilities:[]},subscription:current}));ws.onMessage(data=>{const frame=JSON.parse(String(data));ws.send(JSON.stringify({type:'result',id:frame.id,result:frame.command.method==='list'?{conversations:[],hasMore:false}:{accepted:true}}));});});
  await page.goto(origin); await page.locator('.subscription-required').click();
  const panel=page.locator('.subscription-modal'); await expect(panel.getByRole('button',{name:'免费试用七天',exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:640});
  await expect(panel.getByLabel('授权码',{exact:true})).toBeInViewport();
  for(const width of [320,390]){
    await page.setViewportSize({width,height:844});
    const geometry=await page.evaluate(()=>{const modal=document.querySelector('.subscription-modal')!.getBoundingClientRect();return{left:modal.left,right:modal.right,width:innerWidth,documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight,windowHeight:innerHeight};});
    expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(geometry.width+1); expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.width); expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.windowHeight+1);
  }
  await panel.getByRole('checkbox').first().check(); await panel.getByRole('button',{name:'免费试用七天',exact:true}).click();
  await expect(panel).toContainText('试用中'); expect(submitted).toEqual({requestId:expect.any(String),termsVersion:TERMS_VERSION});
});

test('keeps the stop action enabled when an already-open conversation expires',async({page})=>{
  let transport:any;let stopped=false;let active=subscription(true);
  await mockPairedBrowser(page);
  await page.routeWebSocket('**/ws/mobile*',ws=>{
    transport=ws;const status=()=>({type:'status',online:true,enabled:true,client:{available:true,capabilities:['safety-status']},subscription:active});ws.send(JSON.stringify(status()));
    ws.onMessage(data=>{const frame=JSON.parse(String(data));const command=frame.command;let result:any;
      if(command.method==='list')result={conversations:[{id:taskId,title:'正在运行的任务',cwd:'C:/fixture',updatedAt:1}],hasMore:false};
      if(command.method==='read')result={id:taskId,title:'正在运行的任务',epoch:'fixture',busy:true,turnId:'fixture-turn',messages:[],requests:[],hasMore:false};
      if(command.method==='safety.status')result={id:taskId,epoch:'fixture',busy:!stopped,turnId:stopped?null:'fixture-turn'};
      if(command.method==='stop'){stopped=true;result={accepted:true};}
      ws.send(JSON.stringify({type:'result',id:frame.id,result}));
    });
  });
  await page.goto(origin);await page.locator('.nav-conversation').filter({hasText:'正在运行的任务'}).click();await expect(page.getByTitle('停止当前生成',{exact:true})).toBeEnabled();
  active={...subscription(),status:'expired'};transport.send(JSON.stringify({type:'status',online:true,enabled:true,client:{available:true,capabilities:['safety-status']},subscription:active}));
  await expect(page.locator('.subscription-required')).toBeVisible();await expect(page.getByTitle('停止当前生成',{exact:true})).toBeEnabled();
  await page.getByTitle('停止当前生成',{exact:true}).click();expect(stopped).toBe(true);await expect(page.getByTitle('停止当前生成',{exact:true})).toHaveCount(0);
});

test('opens native-launched local subscription view after binding the private local session',async({page})=>{
  await page.route('**/api/bootstrap',r=>r.fulfill({json:{mode:'desktop'}}));
  await page.route('**/local/session',r=>r.fulfill({json:{ok:true}}));await page.route('**/local/state',r=>r.fulfill({json:{deviceId:'123456789',code:'FIXTURE1',enabled:true,connection:'online',client:{available:true,version:'fixture'},authorizedCount:0,subscription:subscription(),url:origin}}));
  await page.route('**/local/subscription',r=>r.fulfill({json:{subscription:subscription(),catalog}}));
  await page.goto(origin+'/?panel=subscription#token=fixture-only');await expect(page.getByRole('dialog',{name:'订阅与权益',exact:true})).toBeVisible();expect(page.url()).toBe(origin+'/');
});

test('shows only the hard-ban notice in the Windows helper and hides product actions',async({page})=>{
  const blocked={...subscription(true),disabled:true as const,access:false};
  await page.route('**/api/bootstrap',r=>r.fulfill({json:{mode:'desktop'}}));
  await page.route('**/local/session',r=>r.fulfill({json:{ok:true}}));
  await page.route('**/local/state',r=>r.fulfill({json:{deviceId:'123456789',code:'FIXTURE1',enabled:true,connection:'online',client:{available:true,version:'fixture'},authorizedCount:0,subscription:blocked,url:origin}}));
  await page.goto(origin+'/#token=fixture-only');
  await expect(page.getByRole('heading',{name:'该设备已被管理员封禁',exact:true})).toBeVisible();
  await expect(page.getByText('检查更新',{exact:true})).toHaveCount(0); await expect(page.getByText('问题反馈',{exact:true})).toHaveCount(0); await expect(page.getByText('允许远程连接',{exact:true})).toHaveCount(0);
});
