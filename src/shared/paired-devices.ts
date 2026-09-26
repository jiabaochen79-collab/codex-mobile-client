export const MAX_PAIRED_DEVICES = 10;
export type PairedDevice = {
  deviceId: string;
  name: string;
  lastUsed: number;
  expires: number;
  remembered: boolean;
  disabled: boolean;
  authorized: boolean;
  online: boolean;
  enabled: boolean;
};
