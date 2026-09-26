import { z } from 'zod';

export const feedbackCategories = { connection: '连接', chat: '聊天与布局', files: '照片与文件', compatibility: '兼容性', update: '更新', billing: '订阅支付', other: '其他' };
export const feedbackStates = { open: '待处理', processing: '处理中', waiting: '待用户补充', resolved: '已解决', closed: '已关闭' };
export const diagnosticSchema = z.object({
  source: z.enum(['mobile', 'desktop']), helperVersion: z.string().regex(/^[\d.]{1,30}$/).optional(),
  clientVersion: z.string().regex(/^[\d.]{1,40}$/).optional(), system: z.enum(['Windows', 'iOS', 'Android', 'macOS', 'Linux', 'other']).optional(),
  browser: z.enum(['Safari', 'Chrome', 'Edge', 'Firefox', 'other']).optional(),
  connection: z.enum(['online', 'offline', 'connecting', 'unknown']).optional(), errorCode: z.string().regex(/^[A-Z0-9_]{1,60}$/).optional(),
  viewport: z.object({ width: z.number().int().min(0).max(20000), height: z.number().int().min(0).max(20000), visualHeight: z.number().min(0).max(20000), offsetTop: z.number().min(-20000).max(20000) }).strict().optional(),
  online: z.boolean().optional()
}).strict();
export const feedbackMessageSchema = z.object({
  requestId: z.string().uuid(), text: z.string().trim().min(1).max(8000),
  images: z.array(z.object({ data: z.string().max(6990510).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict()).max(3).default([]),
  diagnostics: z.array(diagnosticSchema).max(2).default([])
}).strict();
export const feedbackCreateSchema = feedbackMessageSchema.extend({ category: z.enum(['connection', 'chat', 'files', 'compatibility', 'update', 'billing', 'other']), occurredAt: z.number().int().min(0), contact: z.string().trim().max(200).default('') }).strict();
export type FeedbackInput = z.infer<typeof feedbackMessageSchema>;
export type FeedbackCreate = z.infer<typeof feedbackCreateSchema>;
