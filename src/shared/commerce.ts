import { z } from 'zod';
import { planIds, PAYMENT_TERMS_VERSION } from './subscription.js';

export const channelSchema = z.enum(['wechat', 'alipay']);
export type PaymentChannel = z.infer<typeof channelSchema>;
export const checkoutSchema = z.object({ planId: z.enum(planIds).exclude(['trial']), planRevision: z.number().int().positive(), channel: channelSchema, termsVersion: z.literal(PAYMENT_TERMS_VERSION), idempotencyKey: z.string().uuid() }).strict();
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export const pagingSchema = z.object({ page: z.coerce.number().int().min(1).default(1), query: z.string().max(100).default(''), status: z.string().max(40).default('') });
export const evidenceSchema = z.string().trim().min(5).max(1000);
export const refundRequestSchema = z.object({ reason: z.enum(['first_purchase', 'unused', 'incompatibility']), explanation: evidenceSchema }).strict();
export type PaymentOrder = {
  id: string; deviceId: string; planId: string; planName: string; priceFen: number; days: number; channel: PaymentChannel;
  status: string; serviceStatus: string; created: number; expires: number; paidAt: number | null; fulfilledAt: number | null;
  billingOrderId: string | null; refundStatus: string | null; lastError: string | null; reconciliationIssue?: string | null;
};
export const paymentStatusNames: Record<string, string> = { pending: '待支付', confirming: '支付确认中', closing: '正在关单', paid: '已支付', closed: '已关闭', refunded: '已退款', review: '异常待处理' };
export const refundStatusNames: Record<string, string> = { requested: '待审核', rejected: '已拒绝', processing: '退款处理中', succeeded: '已退款', failed: '退款失败' };
export const money = (fen: number) => (fen / 100).toFixed(2);
