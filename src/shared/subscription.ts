import { z } from 'zod';

export const TERMS_VERSION = '2026-09-08-v1';
export const PAYMENT_TERMS_VERSION = '2026-09-08-payments-v1';
export const DAY = 86400000;
export const MEDIA_DEVICE_BPS = 3000000;
export const licenseCodeSchema = z.string().trim().regex(/^CM1_[A-Za-z0-9_-]{32}$/);
export const redeemSchema = z.object({ code: licenseCodeSchema, termsVersion: z.literal(TERMS_VERSION) }).strict();
export const planIds = ['trial', 'month', 'quarter', 'year'] as const;
export const legacyPlanIds = ['beta_month'] as const;
export type PlanId = typeof planIds[number];
export type LegacyPlanId = typeof legacyPlanIds[number];
export const PLANS = [
  { id: 'trial', name: '七天试用', priceFen: 0, days: 7 },
  { id: 'month', name: '月付', priceFen: 600, days: 30 },
  { id: 'quarter', name: '季付', priceFen: 1500, days: 90 },
  { id: 'year', name: '年付', priceFen: 5000, days: 365 }
] as const;
export const subscriptionSchema = z.object({
  mode: z.enum(['free', 'licensed']),
  status: z.enum(['free', 'trial', 'active', 'expired', 'unlicensed']),
  disabled: z.literal(true).optional(),
  access: z.boolean(), expiresAt: z.number().int().nullable(),
  planId: z.enum([...planIds, ...legacyPlanIds] as [string, ...string[]]).nullable(), serverTime: z.number().int(), revision: z.string(),
  termsVersion: z.literal(TERMS_VERSION)
}).strict();
export type Subscription = z.infer<typeof subscriptionSchema>;
export type TrialEligibility = { available: boolean; reason: string; used: boolean; enabled: boolean; days: 7 };
export type Catalog = {
  salesOpen: boolean; operatorName: string; supportContact: string; termsVersion: string;
  plans: { id: PlanId; name: string; priceFen: number; days: number; available: boolean; reason: string; revision?: number }[];
  limits: { computers: number; terminals: number; controllers: number; mediaBps: number; fileBytes: number; attachmentCount: number; attachmentBytes: number; trafficQuota: null; autoRenew: false };
};
export const subscriptionLabel = (s?: Subscription | null) => !s ? '订阅状态待同步' : s.disabled ? '远程使用已被封禁' : ({ free: '免费试运行', trial: '邀请试用中', active: '订阅有效', expired: '订阅已到期', unlicensed: '未开通订阅' })[s.status];
