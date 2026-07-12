import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureAdvancedOperations } from './CaptureAdvancedOperations';

const api = vi.hoisted(() => ({
  applyCaptureCameraStorageRoots: vi.fn(),
  chooseCaptureLocalDirectory: vi.fn(),
  chooseCaptureLocalFile: vi.fn(),
  importCaptureProfileFromProviderPath: vi.fn(),
  readCaptureProfile: vi.fn(),
  readCaptureProfiles: vi.fn(),
  runCaptureContinuousTest: vi.fn(),
  saveCaptureProfile: vi.fn(),
}));

vi.mock('../lib/capture-api', () => api);

const profiles = {
  code: 0,
  activeProfile: 'current-6-soft-trigger',
  profiles: ['current-6-soft-trigger', 'maintenance-review'],
  profileRoot: 'D:/capture/config/profiles',
  profileEntries: [
    {
      name: 'current-6-soft-trigger',
      path: 'D:/capture/config/profiles/current-6-soft-trigger/profile.json',
      active: true,
    },
  ],
};

const storage = {
  code: 0,
  root: 'H:/',
  exists: true,
  writable: true,
  cameraRoots: [
    { ip: '192.168.101.100', root: 'H:/camera3', exists: true, writable: true },
    { ip: '192.168.102.100', root: 'H:/camera2', exists: true, writable: true },
  ],
};

const cameraIps = ['192.168.101.100', '192.168.102.100'];

function renderTools(ips = cameraIps) {
  return render(
    <CaptureAdvancedOperations
      cameraIps={ips}
      profiles={profiles}
      storage={storage}
      onProfilesChange={vi.fn()}
      onStorageChange={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.readCaptureProfile.mockResolvedValue({
    schema: 'steel.capture.profile.v1',
    name: 'current-6-soft-trigger',
    driverMode: 'lvm',
    saveToDevice: false,
  });
  api.readCaptureProfiles.mockResolvedValue(profiles);
  api.saveCaptureProfile.mockResolvedValue({
    code: 0,
    name: 'new-safe-profile',
    path: 'D:/capture/config/profiles/new-safe-profile/profile.json',
    active: false,
  });
  api.importCaptureProfileFromProviderPath.mockResolvedValue({
    code: 0,
    name: 'reviewed-import',
    path: 'D:/capture/config/profiles/reviewed-import/profile.json',
    active: false,
  });
  api.applyCaptureCameraStorageRoots.mockResolvedValue(storage);
  api.runCaptureContinuousTest.mockResolvedValue({
    schema: 'steel.capture.continuous-test.summary.v1',
    code: 0,
    attempts: 2,
    successes: 2,
    failures: 0,
    completeFrames: 2,
    metadataFrames: 2,
    rounds: 1,
    retries: 0,
    cameraCount: 2,
    expectedCameras: 2,
    expectedMet: true,
    parallel: true,
    elapsedMs: 42,
    storageAsyncFrames: 2,
    captureStorageOverlappedRounds: 0,
    frameTransaction: true,
    metadataCommitLast: true,
    syncMode: 'round-start-condition-variable+storage-ticket-pipeline',
    summaryExists: true,
    summaryOutput: 'H:/continuous-test/summary.json',
    results: [
      {
        round: 1,
        attempt: 1,
        ip: '192.168.101.100',
        code: 0,
        errorName: 'CORRECT',
        completeFrame: true,
        depthExists: true,
        intensityExists: true,
        metadataExists: true,
        storageAsync: true,
        storageTicketId: 7,
        output: 'H:/camera3/continuous-test/depth/000001.png',
      },
    ],
  });
});

describe('CaptureAdvancedOperations', () => {
  it('edits all six structured camera fields and keeps JSON/storage mappings synchronized', async () => {
    const sixIps = Array.from({ length: 6 }, (_, index) => `192.168.10${index + 1}.100`);
    api.readCaptureProfile.mockResolvedValue({
      schema: 'steel.capture.profile.v1',
      name: 'current-6-soft-trigger',
      vendorExtension: { keep: true },
      saveToDevice: false,
      cameras: sixIps.map((ip, index) => ({
        ip,
        enabled: true,
        model: `LVM-${index + 1}`,
        sn: `SN-${index + 1}`,
        paramSource: 'device',
        paramFile: '',
        storageRoot: `H:/camera${index + 1}`,
        params: { exposureTime: 1000, gainK: 1, timeTriggerFreq: 300 },
      })),
    });

    renderTools(sixIps);
    await screen.findByDisplayValue('LVM-6');

    fireEvent.change(screen.getByLabelText('Profile 相机 1 IP'), { target: { value: '10.0.0.11' } });
    fireEvent.change(screen.getByLabelText('Profile 相机 1 型号'), { target: { value: 'LVM3450CA' } });
    fireEvent.change(screen.getByLabelText('Profile 相机 1 SN'), { target: { value: 'YF-0001' } });
    fireEvent.change(screen.getByLabelText('Profile 相机 1 参数来源'), { target: { value: 'file' } });
    fireEvent.change(screen.getByLabelText('Profile 相机 1 参数文件'), { target: { value: 'config/camera-params/cam1.nccfg' } });
    fireEvent.change(screen.getByLabelText('Profile 相机 1 存储目录'), { target: { value: 'E:/steel/camera1' } });
    fireEvent.change(screen.getByLabelText('Profile 相机 1 曝光'), { target: { value: '1250' } });
    fireEvent.change(screen.getByLabelText('Profile 相机 1 增益'), { target: { value: '1.25' } });
    fireEvent.change(screen.getByLabelText('Profile 相机 1 触发频率'), { target: { value: '450' } });
    fireEvent.click(screen.getByLabelText('Profile 相机 6 启用'));

    const document = JSON.parse((screen.getByLabelText('Profile JSON') as HTMLTextAreaElement).value);
    expect(document.vendorExtension).toEqual({ keep: true });
    expect(document.saveToDevice).toBe(false);
    expect(document.expectedCameras).toBe(5);
    expect(document.cameras).toHaveLength(6);
    expect(document.cameras[0]).toMatchObject({
      ip: '10.0.0.11',
      model: 'LVM3450CA',
      sn: 'YF-0001',
      paramSource: 'file',
      useDeviceParams: false,
      paramFile: 'config/camera-params/cam1.nccfg',
      storageRoot: 'E:/steel/camera1',
      params: { exposureTime: 1250, gainK: 1.25, timeTriggerFreq: 450 },
    });
    expect(document.cameras[5].enabled).toBe(false);
    expect(document.cameraStorageRoots[0]).toEqual({ ip: '10.0.0.11', root: 'E:/steel/camera1' });
  });

  it('reads provider profiles and saves a reviewed safe draft without browser upload', async () => {
    const { container } = renderTools();

    await waitFor(() => {
      expect(api.readCaptureProfile).toHaveBeenCalledWith('current-6-soft-trigger');
    });
    expect(
      (screen.getByLabelText('Profile JSON') as HTMLTextAreaElement).value,
    ).toContain('current-6-soft-trigger');
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.getByText(/受控诊断\/维护面板/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('草稿/保存名称'), {
      target: { value: 'new-safe-profile' },
    });
    fireEvent.click(screen.getByRole('button', { name: '新建安全草稿' }));
    const draft = JSON.parse(String((screen.getByLabelText('Profile JSON') as HTMLTextAreaElement).value));
    expect(draft).toMatchObject({
      name: 'new-safe-profile',
      autoConnect: false,
      applySoftTrigger: false,
      loadCameraParams: false,
      saveToDevice: false,
      expectedCameras: 2,
    });

    const saveButton = screen.getByRole('button', { name: '保存 Profile' });
    expect(saveButton).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText(/我已审阅 JSON，确认写入采集主机 Profile 文件/),
    );
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(api.saveCaptureProfile).toHaveBeenCalledWith({
        name: 'new-safe-profile',
        profile: expect.objectContaining({
          name: 'new-safe-profile',
          saveToDevice: false,
        }),
        makeActive: false,
      });
    });
  });

  it('imports only a provider path and replaces explicit per-camera storage roots after confirmation', async () => {
    renderTools();
    await screen.findByText(/已从采集服务读取 Profile/);

    fireEvent.change(screen.getByLabelText('provider 本地文件或目录路径'), {
      target: { value: 'D:/offline/profiles/reviewed' },
    });
    fireEvent.change(screen.getByLabelText('导入名称（可选）'), {
      target: { value: 'reviewed-import' },
    });
    fireEvent.click(
      screen.getByLabelText('我确认该路径位于采集服务主机，且已审阅覆盖/激活选项'),
    );
    fireEvent.click(screen.getByRole('button', { name: '导入 provider Profile' }));

    await waitFor(() => {
      expect(api.importCaptureProfileFromProviderPath).toHaveBeenCalledWith({
        path: 'D:/offline/profiles/reviewed',
        name: 'reviewed-import',
        overwrite: false,
        makeActive: false,
      });
    });

    fireEvent.change(screen.getByLabelText('相机 192.168.101.100 落盘目录'), {
      target: { value: 'E:/steel/camera-one' },
    });
    fireEvent.click(
      screen.getByLabelText('我确认替换全部逐相机目录；后续生产帧将按新映射落盘'),
    );
    fireEvent.click(screen.getByRole('button', { name: '应用逐相机目录' }));

    await waitFor(() => {
      expect(api.applyCaptureCameraStorageRoots).toHaveBeenCalledWith({
        replace: true,
        cameraRoots: [
          { ip: '192.168.101.100', root: 'E:/steel/camera-one' },
          { ip: '192.168.102.100', root: 'H:/camera2' },
        ],
      });
    });
  });

  it('runs the admin continuous-test workflow and renders structured summary/results', async () => {
    renderTools();
    await screen.findByText(/已从采集服务读取 Profile/);

    fireEvent.change(screen.getByLabelText('测试轮数'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('轮间隔 ms'), { target: { value: '250' } });
    fireEvent.click(
      screen.getByLabelText(/我确认对 2 路相机执行 1 轮并行触发/),
    );
    fireEvent.click(screen.getByRole('button', { name: '执行连续测试' }));

    await waitFor(() => {
      expect(api.runCaptureContinuousTest).toHaveBeenCalledWith({
        expectedCameras: 2,
        rounds: 1,
        lines: 1000,
        width: 0,
        timeoutMs: 8000,
        intervalMs: 250,
        retries: 2,
        controlMode: 0,
        dataMode: 3,
        outputDir: 'continuous-test/tauri-operations',
        connectFirst: false,
        stopStreams: true,
        ips: cameraIps,
        discardBlackFrames: true,
      });
    });
    expect(await screen.findAllByText('2/2')).toHaveLength(2);
    expect(screen.getByText('async #7')).toBeInTheDocument();
    expect(screen.getAllByText('是', { selector: '.capture-continuous-summary dd' })).toHaveLength(2);
  });
});
