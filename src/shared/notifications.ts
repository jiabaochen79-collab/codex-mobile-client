import { z } from 'zod';

export const notificationStatusSchema = z.enum(['completed', 'failed', 'interrupted']);
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;

export const notificationEventSchema = z.object({
  eventId: z.string().regex(/^[a-f0-9]{64}$/),
  deviceId: z.string().regex(/^[1-9][0-9]{8}$/),
  taskId: z.string().uuid(),
  turnId: z.string().min(1).max(200),
  status: notificationStatusSchema,
  occurredAt: z.number().int().positive(),
  protocolVersion: z.literal(1)
}).strict();
export type NotificationEvent = z.infer<typeof notificationEventSchema>;
export type LocalNotificationEvent = Omit<NotificationEvent, 'deviceId'>;

export const notificationSettingsSchema = z.object({
  enabled: z.boolean(),
  completed: z.boolean(),
  failed: z.boolean()
}).strict();
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().startsWith('https://').max(2048),
  keys: z.object({
    p256dh: z.string().min(16).max(256),
    auth: z.string().min(8).max(128)
  }).strict(),
  browser: z.string().trim().min(1).max(80).optional()
}).strict();
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

export type NotificationItem = {
  id: string;
  deviceId: string;
  taskId: string;
  turnId: string;
  status: NotificationStatus;
  occurredAt: number;
  createdAt: number;
  readAt: number | null;
  delivery: 'pending' | 'sending' | 'accepted' | 'sent' | 'retry_wait' | 'failed' | 'unknown' | 'suppressed' | 'expired';
};
