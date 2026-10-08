import { z } from 'zod';

export const releaseManifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/), sequence: z.number().int().positive().max(2147483647),
  platform: z.literal('win32-x64'), size: z.number().int().min(1).max(512 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), path: z.string().regex(/^\/api\/updates\/download\/[a-f0-9]{64}$/),
  notes: z.string().trim().min(1).max(8000), issuedAt: z.number().int().positive()
}).strict();
export const releaseUploadSchema = releaseManifestSchema.pick({ sha256: true, size: true }).strict();
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
export const updateStateSchema = z.object({ phase: z.enum(['idle', 'checking', 'available', 'downloading', 'ready', 'installing', 'error']), version: z.string().max(40).optional(), progress: z.number().min(0).max(100).default(0), autoDownload: z.boolean().default(true), message: z.string().max(1000).default(''), notes: z.string().max(8000).default(''), checkedAt: z.number().nullable().default(null) }).strict();
export type UpdateState = z.infer<typeof updateStateSchema>;
// Leave headroom below common reverse-proxy 256 KiB request limits.
export const RELEASE_UPLOAD_CHUNK = 240 * 1024;
export function compareVersions(a: string, b: string) { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1; return 0; }
