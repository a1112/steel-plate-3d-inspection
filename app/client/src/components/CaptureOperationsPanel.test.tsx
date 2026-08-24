import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureOperationsPanel } from './CaptureOperationsPanel';

const api = vi.hoisted(() => ({
  applyCaptureCameraStorageRoots: vi.fn(),
  applyCaptureProfile: vi.fn(),
  applyCaptureStorageRoot: vi.fn(),
  connectAllCaptureCameras: vi.fn(),
  defaultCaptureProfileName: vi.fn((cameraCount: number) => `current-${cameraCount}-time-trigger`),
  chooseCaptureLocalDirectory: vi.fn(),
  importCaptureProfileFromProviderPath: vi.fn(),
  loadAllCaptureCameraParams: vi.fn(),
  openCaptureLocalPath: vi.fn(),
  readCaptureProfile: vi.fn(),
  readCaptureProfiles: vi.fn(),
  readCaptureStorageStatus: vi.fn(),
  recoverCaptureCameraParams: vi.fn(),
  runCaptureContinuousTest: vi.fn(),
  saveCaptureProfile: vi.fn(),
  saveAllCaptureCameraParams: vi.fn(),
}));

vi.mock('../lib/capture-api', () => api);
vi.mock('./CaptureDiagnosticOperations', () => ({ CaptureDiagnosticOperations: () => null }));

const profileStatus = {
  code: 0,
  activeProfile: 'current-6-soft-trigger',
  profiles: ['current-6-soft-trigger', 'maintenance-review'],
};

const storageStatus = {
  code: 0,
  root: 'H:/',
  exists: true,
  writable: true,
  queue: {
    workerCount: 2,
    capacityItems: 24,
    capacityBytes: 512 * 1024 * 1024,
    pendingItems: 0,
    pendingBytes: 0,
    queued: 0,
    queuedBytes: 0,
    active: 0,
    activeBytes: 0,
    highWaterItems: 4,
    highWaterBytes: 64 * 1024 * 1024,
    completed: 32,
    failed: 0,
    rejected: 0,
    enqueueTimeoutMs: 2000,
    accepting: true,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.readCaptureProfiles.mockResolvedValue(profileStatus);
  api.readCaptureProfile.mockResolvedValue({
    schema: 'steel.capture.profile.v1',
    name: 'current-6-soft-trigger',
    saveToDevice: false,
  });
  api.readCaptureStorageStatus.mockResolvedValue(storageStatus);
  api.applyCaptureProfile.mockResolvedValue({ code: 0, connected: 2, failed: 0 });
  api.applyCaptureStorageRoot.mockResolvedValue(storageStatus);
  api.connectAllCaptureCameras.mockResolvedValue({ code: 0, connected: 2, failed: 0, results: [] });
  api.saveAllCaptureCameraParams.mockResolvedValue({ code: 0, saved: 2, failed: 0, results: [] });
  api.loadAllCaptureCameraParams.mockResolvedValue({ code: 0, loaded: 2, failed: 0, results: [] });
  api.recoverCaptureCameraParams.mockResolvedValue({ code: 0, results: [] });
});

describe('CaptureOperationsPanel', () => {
  it('uses the configured camera count when the active camera list is temporarily empty', async () => {
    render(<CaptureOperationsPanel cameraIps={[]} expectedCameraCount={8} />);

    await screen.findByText('当前：current-6-soft-trigger');
    fireEvent.click(
      screen.getByLabelText('我确认应用会改变相机当前运行参数，并可能连接设备'),
    );
    fireEvent.click(screen.getByRole('button', { name: '应用 Profile' }));

    await waitFor(() => {
      expect(api.applyCaptureProfile).toHaveBeenCalledWith(
        expect.objectContaining({ expectedCameras: 8 }),
      );
    });
  });

  it('shows provider profile/storage queue state and applies a safe profile', async () => {
    render(
      <CaptureOperationsPanel
        cameraIps={['192.168.101.100', '192.168.102.100']}
      />,
    );

    expect(await screen.findByText('当前：current-6-soft-trigger')).toBeInTheDocument();
    expect(screen.getByText('0/24')).toBeInTheDocument();
    expect(screen.getByText('32/0')).toBeInTheDocument();

    fireEvent.click(
      screen.getByLabelText('我确认应用会改变相机当前运行参数，并可能连接设备'),
    );
    fireEvent.click(screen.getByRole('button', { name: '应用 Profile' }));
    await waitFor(() => {
      expect(api.applyCaptureProfile).toHaveBeenCalledWith({
        name: 'current-6-soft-trigger',
        expectedCameras: 2,
        autoConnect: true,
        loadCameraParams: false,
        saveToDevice: false,
        changeStorage: false,
      });
    });
    expect(await screen.findByText(/配置 current-6-soft-trigger 已应用/)).toBeInTheDocument();
  });

  it('requires explicit confirmation before loading camera parameter files', async () => {
    render(
      <CaptureOperationsPanel
        cameraIps={['192.168.101.100', '192.168.102.100']}
      />,
    );
    await screen.findByText('当前：current-6-soft-trigger');

    const loadButton = screen.getByRole('button', { name: '加载全部参数' });
    expect(loadButton).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText('我确认当前没有采集或实时流，允许加载参数文件'),
    );
    expect(loadButton).toBeEnabled();
    fireEvent.click(loadButton);

    await waitFor(() => {
      expect(api.loadAllCaptureCameraParams).toHaveBeenCalledWith({
        name: 'current-6-soft-trigger',
        ips: ['192.168.101.100', '192.168.102.100'],
        cameraParamDir: 'config/camera-params/current-6-soft-trigger',
        applySoftTrigger: false,
        saveToDevice: false,
        allowExternal: false,
      });
    });
  });

  it('does not switch the storage root until the operator confirms it', async () => {
    render(<CaptureOperationsPanel cameraIps={['192.168.101.100']} />);
    await screen.findByText('当前：current-6-soft-trigger');

    fireEvent.change(screen.getByLabelText('根目录'), {
      target: { value: 'E:/steel-capture-data' },
    });
    fireEvent.click(screen.getByRole('button', { name: '应用存储目录' }));
    expect(api.applyCaptureStorageRoot).not.toHaveBeenCalled();
    expect(screen.getByText('请先确认切换正式落盘根目录')).toBeInTheDocument();

    fireEvent.click(
      screen.getByLabelText('我确认后续采集切换到这个落盘根目录'),
    );
    fireEvent.click(screen.getByRole('button', { name: '应用存储目录' }));
    await waitFor(() => {
      expect(api.applyCaptureStorageRoot).toHaveBeenCalledWith(
        'E:/steel-capture-data',
      );
    });
  });

  it('keeps unsupported SICK device mutations read-only while leaving capture controls available', async () => {
    render(
      <CaptureOperationsPanel
        cameraIps={['192.168.101.144', '192.168.102.206']}
        expectedCameraCount={2}
        cameraStatuses={[
          { ip: '192.168.101.144', driverId: 'sick-gentl-harvesters' },
          { ip: '192.168.102.206', driverId: 'sick-gentl-harvesters' },
        ] as never}
      />,
    );

    expect(await screen.findByText(/SICK Ranger3 的设备参数/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发现并连接全部' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '应用 Profile' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存全部参数' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '加载全部参数' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '恢复选中相机' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '应用存储目录' })).toBeDisabled();
    expect(screen.getByText('Profile 与分盘配置只读')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '读取当前 Profile' })).toBeEnabled();
    expect(screen.getByText('并行连续采集测试')).toBeInTheDocument();
  });
});
