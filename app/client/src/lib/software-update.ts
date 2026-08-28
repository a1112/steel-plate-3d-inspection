import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import packageMetadata from '../../package.json';

export type SoftwareUpdateStatus = {
  currentVersion: string;
  configured: boolean;
  channel: 'stable';
  reason?: string | null;
};

export type SoftwareUpdateCheckResult = {
  currentVersion: string;
  available: boolean;
  version?: string | null;
  date?: string | null;
  notes?: string | null;
};

export type SoftwareUpdateEvent =
  | { event: 'started'; data: { contentLength?: number | null } }
  | { event: 'progress'; data: { chunkLength: number; downloaded: number } }
  | { event: 'downloaded' }
  | { event: 'installing' };

const browserStatus: SoftwareUpdateStatus = {
  currentVersion: packageMetadata.version,
  configured: false,
  channel: 'stable',
  reason: '当前为浏览器开发预览，软件安装仅在正式桌面客户端中可用',
};

export async function readSoftwareUpdateStatus(): Promise<SoftwareUpdateStatus> {
  if (!isTauri()) return browserStatus;
  return invoke<SoftwareUpdateStatus>('read_software_update_status');
}

export async function checkSoftwareUpdate(): Promise<SoftwareUpdateCheckResult> {
  if (!isTauri()) throw new Error(browserStatus.reason ?? '软件更新仅支持桌面客户端');
  return invoke<SoftwareUpdateCheckResult>('check_software_update');
}

export async function installSoftwareUpdate(
  onEvent: (event: SoftwareUpdateEvent) => void,
) {
  if (!isTauri()) throw new Error(browserStatus.reason ?? '软件更新仅支持桌面客户端');
  const channel = new Channel<SoftwareUpdateEvent>();
  channel.onmessage = onEvent;
  await invoke('install_software_update', { onEvent: channel });
}

export function formatSoftwareUpdateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  const separator = message.indexOf(':');
  if (separator >= 0 && /^software_update_[a-z_]+$/i.test(message.slice(0, separator))) {
    return message.slice(separator + 1).trim();
  }
  return message;
}
