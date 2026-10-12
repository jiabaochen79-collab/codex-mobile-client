import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
const webkit = process.env.TEST_BROWSER === 'webkit';
test.use({ browserName:webkit?'webkit':'chromium',viewport:{width:390,height:844},launchOptions:webkit?{}:{executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'} });
const origin='http://127.0.0.1:18890';
const password='Fixture-Only-Password42';
let deviceId:string;
test.beforeEach(async({request})=>{
  const token=process.env.FIXTURE_LOCAL_TOKEN;if(!token)throw new Error('Start tests/browser-fixture.ts and pass FIXTURE_LOCAL_TOKEN.');
  const response=await request.post('http://127.0.0.1:18891/local/password',{headers:{Authorization:`Bearer ${token}`,Origin:'http://127.0.0.1:18891'},data:{mode:'custom',password}});
  expect(response.ok()).toBe(true);deviceId=(await response.json()).deviceId;
});
async function login(page:Page){await page.goto(origin);await page.getByLabel('设备 ID',{exact:true}).fill(deviceId);await page.getByLabel('验证码或自定义密码').fill(password);await page.getByRole('button',{name:'连接',exact:true}).click();const project=page.locator('.project-toggle').filter({hasText:'产品研发'});if(await project.getAttribute('aria-expanded')!=='true')await project.click();await page.locator('.nav-conversation').filter({hasText:'移动端验收记录'}).click();await expect(page.getByLabel('消息',{exact:true})).toBeVisible();}
test('connects with all sixty-four typed password characters', async ({ page, request }) => {
  const longPassword = 'Ab9!'.repeat(16);
  const saved = await request.post('http://127.0.0.1:18891/local/password', { headers: { Authorization: `Bearer ${process.env.FIXTURE_LOCAL_TOKEN}`, Origin: 'http://127.0.0.1:18891' }, data: { mode: 'custom', password: longPassword } });
  expect(saved.ok()).toBe(true);
  await page.goto(origin); await page.getByLabel('设备 ID', { exact: true }).fill(deviceId);
  await page.getByLabel('验证码或自定义密码').pressSequentially(longPassword);
  await expect(page.getByLabel('验证码或自定义密码')).toHaveValue(longPassword);
  await expect(page.getByText('64 / 64', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目与会话', exact: true })).toBeVisible();
  await page.getByTitle('退出登录', { exact: true }).click();
});
test('uploads a file, reads its content and preserves the run/unread/view lifecycle',async({page},testInfo)=>{
  await login(page);
  await page.locator('input[data-attachment-source=files]').setInputFiles({name:'验收.txt',mimeType:'text/plain',buffer:Buffer.from('UPLOAD-CONTENT-VERIFIED 中文')});
  await expect(page.getByText('已上传',{exact:true})).toBeVisible();await page.getByLabel('消息',{exact:true}).fill('检查附件内容');await page.getByTitle('发送消息',{exact:true}).click();
  await page.getByTitle('项目与会话',{exact:true}).click();await expect(page.getByLabel('正在执行',{exact:true})).toBeVisible();
  await expect(page.getByLabel('完成未读',{exact:true})).toBeVisible({timeout:12000});await page.screenshot({path:testInfo.outputPath('unread-mobile.png')});
  await page.locator('.nav-conversation').filter({hasText:'移动端验收记录'}).click();await expect(page.getByText('UPLOAD-CONTENT-VERIFIED 中文',{exact:false})).toBeVisible();
  await page.getByTitle('项目与会话',{exact:true}).click();await expect(page.getByLabel('完成未读',{exact:true})).toHaveCount(0);
});
test('folds finished execution into a round and command batch with independent script details', async ({ page }, testInfo) => {
  await login(page);
  const turn = page.locator('.conversation-turn').filter({ hasText: '请整理第 4 次检查结果。' });
  const process = turn.locator('details.turn-process'); await expect(process).not.toHaveAttribute('open', '');
  await expect(turn.getByText('思考摘要', { exact: true })).toHaveCount(0);
  await process.locator(':scope > summary').click();
  await expect(turn.getByText('正在核对本轮数据。', { exact: true })).toBeVisible();
  const batch = process.locator('.tool-batch'); await expect(batch).not.toHaveAttribute('open', '');
  await batch.locator(':scope > summary').click();
  const step = turn.locator('details.tool-step'); await expect(step).toBeVisible(); await expect(step).not.toHaveAttribute('open', '');
  await expect(step.locator('.tool-summary')).toHaveCSS('white-space', 'nowrap');
  await expect(step.locator('pre')).toBeHidden();
  await turn.scrollIntoViewIfNeeded(); await turn.screenshot({ path:testInfo.outputPath('process-compact-mobile.png') });
  await page.setViewportSize({ width: 320, height: 568 }); await turn.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const row = await step.locator('summary').boundingBox(); expect(row).not.toBeNull(); expect(row!.x).toBeGreaterThanOrEqual(0); expect(row!.x + row!.width).toBeLessThanOrEqual(320);
  await step.locator('summary').click(); await expect(step).toHaveAttribute('open', ''); await expect(step.locator('pre')).toContainText('Write-Output "检查完成"');
});
test('hides the desktop attachment envelope but keeps the image and request', async ({ page }, testInfo) => {
  await login(page);
  const turn = page.locator('.conversation-turn').filter({ hasText: '请整理第 4 次检查结果。' });
  await expect(turn.locator('.message.user img')).toBeVisible(); await expect(turn.getByText('请整理第 4 次检查结果。', { exact: true })).toBeVisible();
  await expect(turn.getByText('Files mentioned by the user', { exact: false })).toHaveCount(0);
  await expect(turn.getByText('Distinguish instructions', { exact: false })).toHaveCount(0);
  await turn.scrollIntoViewIfNeeded(); await turn.screenshot({ path:testInfo.outputPath('attachment-clean-mobile.png') });
});
test('opens photo-library and camera pickers separately from ordinary files', async ({ page }, testInfo) => {
  await login(page); await page.getByTitle('添加照片、文件或任务模式', { exact: true }).click();
  await expect(page.getByRole('button', { name: '照片图库', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '拍照', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '文件', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('photo-sources.png') });
  const photoChoice = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '照片图库', exact: true }).click();
  const photos = await photoChoice;
  expect(photos.isMultiple()).toBe(true); expect(await photos.element().getAttribute('accept')).toBe('image/*');
  expect(await photos.element().getAttribute('capture')).toBeNull();
  const jpeg = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#278f70' } }).jpeg().toBuffer();
  const png = await sharp({ create: { width: 60, height: 80, channels: 3, background: '#3f70ca' } }).png().toBuffer();
  await photos.setFiles([{ name: '图库照片.JPG', mimeType: 'image/jpeg', buffer: jpeg }, { name: '截图.png', mimeType: 'image/png', buffer: png }]);
  await expect(page.getByText('已上传', { exact: true })).toHaveCount(2, { timeout: 15000 });
  await expect(page.locator('.pending-attachment img')).toHaveCount(2);
  expect(await page.locator('.pending-attachment img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await page.getByTitle('添加照片、文件或任务模式', { exact: true }).click();
  const cameraChoice = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '拍照', exact: true }).click();
  const camera = await cameraChoice; expect(camera.isMultiple()).toBe(false);
  expect(await camera.element().getAttribute('accept')).toBe('image/*'); expect(await camera.element().getAttribute('capture')).toBe('environment');
  await camera.setFiles([]); await expect(page.getByText('已上传', { exact: true })).toHaveCount(2);
  await page.getByTitle('添加照片、文件或任务模式', { exact: true }).click();
  const fileChoice = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '文件', exact: true }).click();
  const files = await fileChoice; expect(await files.element().getAttribute('accept')).toBeNull();
  await files.setFiles([]);
});
test('converts a real HEIC photo locally and uploads it as a previewable JPEG', async ({ page }, testInfo) => {
  const source = process.env.HEIC_TEST_FILE;
  test.skip(!source, 'Set HEIC_TEST_FILE to an actual HEIC sample.');
  const errors: string[] = []; const completed: any[] = []; const decoderRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/assets\/heic-to-/.test(request.url())) decoderRequests.push(request.url()); });
  page.on('websocket', socket => socket.on('framereceived', event => { try { const frame = JSON.parse(String(event.payload)); if (frame.type === 'result' && frame.result?.ready) completed.push(frame.result); } catch {} }));
  await login(page); await page.getByTitle('添加照片、文件或任务模式', { exact:true }).click();
  const choice = page.waitForEvent('filechooser'); await page.getByRole('button', { name:'照片图库', exact:true }).click();
  await (await choice).setFiles(source!);
  await expect(page.getByText('已上传', { exact:true })).toBeVisible({ timeout:30000 });
  await expect(page.locator('.pending-attachment strong')).toHaveText('example.jpg');
  await expect(page.locator('.pending-attachment img')).toBeVisible();
  const pixels = await page.locator('.pending-attachment img').evaluate(element => {
    const image = element as HTMLImageElement; const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 24;
    const context = canvas.getContext('2d')!; context.drawImage(image,0,0,24,24);
    const data = context.getImageData(0,0,24,24).data;
    return { width:image.naturalWidth, height:image.naturalHeight, colors:new Set(Array.from({length:24*24},(_,index)=>`${data[index*4]},${data[index*4+1]},${data[index*4+2]}`)).size };
  });
  expect(pixels.width).toBeGreaterThan(0); expect(pixels.height).toBeGreaterThan(0); expect(pixels.colors).toBeGreaterThan(10);
  expect(completed.some(file=>file.name==='example.jpg'&&file.mediaType==='image/jpeg')).toBe(true);
  expect(decoderRequests).toHaveLength(1); expect(errors).toEqual([]);
  await page.screenshot({ path:testInfo.outputPath('heic-preview.png') });
});
test('uses model-specific reasoning options and keeps the selected next-turn model',async({page})=>{
  await login(page);await page.locator('.model-trigger').click();await page.getByLabel('模型',{exact:true}).selectOption('fixture-fast');
  await expect(page.getByLabel('思考深度',{exact:true}).locator('option')).toHaveCount(1);
  await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.locator('.model-trigger')).toContainText('fixture-fast');
  await page.reload();const project=page.locator('.project-toggle').filter({hasText:'产品研发'});if(await project.getAttribute('aria-expanded')!=='true')await project.click();await page.locator('.nav-conversation').filter({hasText:'移动端验收记录'}).click();await expect(page.locator('.model-trigger')).toContainText('fixture-fast');
});
test('supports viewers and explicit takeover with intact drafts at phone widths',async({page,browser},testInfo)=>{
  await login(page);await page.getByLabel('消息',{exact:true}).fill('第一终端草稿');
  const second=await browser.newContext({viewport:{width:320,height:568},isMobile:true,hasTouch:true});const viewer=await second.newPage();
  try{await login(viewer);await expect(viewer.getByTitle('接管控制权',{exact:true})).toBeVisible();await viewer.getByTitle('添加照片、文件或任务模式',{exact:true}).click();await expect(viewer.getByRole('button',{name:'照片图库',exact:true})).toBeDisabled();await viewer.getByTitle('关闭添加内容',{exact:true}).click();
    await viewer.getByTitle('接管控制权',{exact:true}).click();await viewer.getByRole('button',{name:'确认接管',exact:true}).click();await expect(page.getByTitle('接管控制权',{exact:true})).toBeVisible();
    await expect(page.getByLabel('消息',{exact:true})).toHaveValue('第一终端草稿');await expect(viewer.getByTitle('添加照片、文件或任务模式',{exact:true})).toBeEnabled();
    expect(await viewer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await viewer.screenshot({path:testInfo.outputPath('controller-320.png')});
  }finally{await second.close();}
});
test('opens task reminders without taking composer space or overflowing phone widths', async ({ page }, testInfo) => {
  await login(page);
  await page.getByTitle('更多操作', { exact: true }).click();
  await page.getByRole('button', { name: '任务完成提醒' }).click();
  await expect(page.getByRole('dialog', { name: '任务完成提醒' })).toBeVisible();
  await expect(page.getByText(/提醒已开启|提醒未开启/)).toBeVisible();
  await expect(page.getByText('站内通知', { exact: false })).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 640 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`notification-center-${width}.png`) });
  }
});
