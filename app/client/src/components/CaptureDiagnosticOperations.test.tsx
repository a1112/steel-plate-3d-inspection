import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAMERA_CALIBRATION_CONFIRMATION,
  CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION,
  CAMERA_CALIBRATION_SET_CONFIRMATION,
  CAMERA_DEVICE_PERSIST_CONFIRMATION,
  CAMERA_ROI_CONFIRMATION,
  CaptureAdminApiError,
  SDK_PARAMETER_WRITE_CONFIRMATION,
} from '../lib/capture-api';
import {
  CaptureDiagnosticOperations,
  LINE_PRESET_CONFIRMATION,
  LINE_PRESET_DEVICE_CONFIRMATION,
} from './CaptureDiagnosticOperations';

const api = vi.hoisted(() => ({
  applyCaptureCalibrationSet: vi.fn(),
  applyCaptureLineContinuousPreset: vi.fn(),
  captureValidationFrame: vi.fn(),
  chooseCaptureLocalFile: vi.fn(),
  loadCaptureCalibration: vi.fn(),
  loadCaptureParamFile: vi.fn(),
  loadCaptureRoi: vi.fn(),
  persistAllCaptureCameraParams: vi.fn(),
  persistCaptureParamsToDevice: vi.fn(),
  readCaptureCalibrationStatus: vi.fn(),
  readCaptureCalibrationOperationDetail: vi.fn(),
  readCaptureParam: vi.fn(),
  rollbackCaptureCalibrationSet: vi.fn(),
  saveCaptureParamFile: vi.fn(),
  writeCaptureParam: vi.fn(),
}));

vi.mock('../lib/capture-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/capture-api')>()),
  ...api,
}));

const cameraIps = Array.from({ length: 8 }, (_, index) => `192.168.${101 + index}.100`);

beforeEach(() => {
  vi.clearAllMocks();
  api.applyCaptureCalibrationSet.mockImplementation(async (input: { dryRun: boolean }) => input.dryRun
    ? {
      code: 0,
      dryRun: true,
      applied: 0,
      failed: 0,
      results: [{
        code: 0,
        ip: cameraIps[0],
        calibrationPath: 'D:/cal/cam1.xml',
        artifactKind: 'camera-sdk',
        preflightCode: 0,
        skipped: true,
        message: 'preflight passed; no SDK call made',
      }],
    }
    : { code: 0, dryRun: false, applied: 8, failed: 0, rollbackToken: 'rollback-1', results: [] });
  api.applyCaptureLineContinuousPreset.mockResolvedValue({ code: 0, applied: 2, failed: 0 });
  api.captureValidationFrame.mockResolvedValue({ code: 0, output: 'validation.png', imageUrl: '/validation.png' });
  api.loadCaptureCalibration.mockResolvedValue({ code: 0, calibrationCode: 0 });
  api.loadCaptureParamFile.mockResolvedValue({ code: 0, saveToDevice: false });
  api.loadCaptureRoi.mockResolvedValue({ code: 0, roiCode: 0 });
  api.persistAllCaptureCameraParams.mockResolvedValue({ code: 0, saved: 2, failed: 0 });
  api.persistCaptureParamsToDevice.mockResolvedValue({ code: 0, saveCode: 0 });
  api.readCaptureCalibrationStatus.mockResolvedValue({
    code: 0,
    calibrationCode: 0,
    calibrationPath: 'D:/cal/cam1.xml',
    roiCode: 0,
    roiPath: 'D:/cal/cam1-roi.xml',
    validationCode: 0,
    validationPath: 'D:/cal/validation.png',
    validationTime: '2026-07-12T01:00:00Z',
    rollbackMode: 'runtime-snapshot',
    rollbackCode: 49001,
    rollbackTime: '2026-07-12T01:05:00Z',
    rollbackToken: 'calrb-status-1',
    maintenanceRecordPath: 'H:/maintenance/calibration-records.jsonl',
  });
  api.readCaptureCalibrationOperationDetail.mockImplementation(async (operationId: string) => ({
    code: 0,
    operationId,
    status: 'succeeded',
    needsReconciliation: false,
  }));
  api.readCaptureParam.mockResolvedValue({ code: 0, key: 'ExposureTime', value: 1000 });
  api.rollbackCaptureCalibrationSet.mockResolvedValue({ code: 0, complete: true });
  api.saveCaptureParamFile.mockResolvedValue({ code: 0, path: 'H:/param-backup/cam1.nccfg' });
  api.writeCaptureParam.mockResolvedValue({ code: 0, key: 'ExposureTime' });
});

describe('CaptureDiagnosticOperations', () => {
  it('requires an exact SDK write phrase and rejects partial integer parsing', async () => {
    render(<CaptureDiagnosticOperations cameraIps={cameraIps} />);

    fireEvent.change(screen.getByLabelText('SDK 参数值'), { target: { value: '1.5' } });
    fireEvent.change(screen.getByLabelText('参数写入确认短语'), { target: { value: SDK_PARAMETER_WRITE_CONFIRMATION } });
    fireEvent.click(screen.getByRole('button', { name: '写入参数' }));
    expect(await screen.findByText('int 参数值不是有效整数')).toBeInTheDocument();
    expect(api.writeCaptureParam).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('SDK 参数值'), { target: { value: '1200' } });
    expect(screen.getByRole('button', { name: '写入参数' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('参数写入确认短语'), { target: { value: SDK_PARAMETER_WRITE_CONFIRMATION } });
    fireEvent.click(screen.getByRole('button', { name: '写入参数' }));

    await waitFor(() => expect(api.writeCaptureParam).toHaveBeenCalledWith({
      ip: cameraIps[0],
      key: 'ExposureTime',
      type: 'int',
      value: 1200,
    }));
  });

  it('keeps parameter-file loading runtime-only by default and gates every device persistence path', async () => {
    render(<CaptureDiagnosticOperations cameraIps={cameraIps} />);

    fireEvent.change(screen.getByLabelText('单相机参数加载文件'), { target: { value: 'config/cam1.nccfg' } });
    fireEvent.change(screen.getByLabelText('参数文件加载确认短语'), { target: { value: `维护 ${cameraIps[0]}` } });
    fireEvent.click(screen.getByRole('button', { name: '加载参数文件到运行态' }));
    await waitFor(() => expect(api.loadCaptureParamFile).toHaveBeenCalledWith({
      ip: cameraIps[0],
      path: 'config/cam1.nccfg',
      allowExternal: false,
      saveToDevice: false,
    }));

    fireEvent.change(screen.getByLabelText('单相机参数设备持久化确认短语'), { target: { value: CAMERA_DEVICE_PERSIST_CONFIRMATION } });
    fireEvent.click(screen.getByRole('button', { name: '持久化当前相机参数' }));
    await waitFor(() => expect(api.persistCaptureParamsToDevice).toHaveBeenCalledWith(cameraIps[0]));

    fireEvent.change(screen.getByLabelText('全部相机参数设备持久化确认短语'), { target: { value: CAMERA_DEVICE_PERSIST_CONFIRMATION } });
    fireEvent.click(screen.getByRole('button', { name: '持久化全部相机参数' }));
    await waitFor(() => expect(api.persistAllCaptureCameraParams).toHaveBeenCalledWith(expect.objectContaining({
      ips: cameraIps,
      applySoftTrigger: false,
    })));
  });

  it('forwards the exact typed confirmation for single-camera calibration and ROI apply', async () => {
    render(<CaptureDiagnosticOperations cameraIps={cameraIps} />);

    fireEvent.change(screen.getByLabelText('单相机标定文件路径'), {
      target: { value: 'D:/cal/cam1.xml' },
    });
    fireEvent.change(screen.getByLabelText('单相机标定确认短语'), {
      target: { value: CAMERA_CALIBRATION_CONFIRMATION },
    });
    fireEvent.click(screen.getByRole('button', { name: '应用标定' }));
    await waitFor(() => expect(api.loadCaptureCalibration).toHaveBeenCalledWith({
      ip: cameraIps[0],
      path: 'D:/cal/cam1.xml',
      allowExternal: false,
      confirmation: CAMERA_CALIBRATION_CONFIRMATION,
    }));

    fireEvent.change(screen.getByLabelText('单相机 ROI 文件路径'), {
      target: { value: 'D:/cal/cam1-roi.xml' },
    });
    fireEvent.change(screen.getByLabelText('单相机 ROI 确认短语'), {
      target: { value: CAMERA_ROI_CONFIRMATION },
    });
    fireEvent.click(screen.getByRole('button', { name: '应用 ROI' }));
    await waitFor(() => expect(api.loadCaptureRoi).toHaveBeenCalledWith({
      ip: cameraIps[0],
      path: 'D:/cal/cam1-roi.xml',
      allowExternal: false,
      confirmation: CAMERA_ROI_CONFIRMATION,
    }));
  });

  it('shows the current rollback mode, code, time and token from calibration status', async () => {
    render(<CaptureDiagnosticOperations cameraIps={cameraIps} />);

    fireEvent.click(screen.getByRole('button', { name: '刷新标定状态' }));
    await waitFor(() => expect(api.readCaptureCalibrationStatus).toHaveBeenCalledWith(cameraIps[0]));

    const status = screen.getByText('回滚模式').closest('dl');
    expect(status).not.toBeNull();
    expect(within(status as HTMLElement).getByText('runtime-snapshot')).toBeInTheDocument();
    expect(within(status as HTMLElement).getByText('49001')).toBeInTheDocument();
    expect(within(status as HTMLElement).getByText('2026-07-12T01:05:00Z')).toBeInTheDocument();
    expect(within(status as HTMLElement).getByText('calrb-status-1')).toBeInTheDocument();
  });

  it('preflights a complete calibration set, shows per-camera evidence, then gates apply and rollback', async () => {
    render(<CaptureDiagnosticOperations cameraIps={cameraIps} />);

    cameraIps.forEach((_, index) => {
      fireEvent.change(screen.getByLabelText(`整组标定相机 ${index + 1} SDK 文件`), {
        target: { value: `D:/cal/cam${index + 1}.xml` },
      });
      fireEvent.change(screen.getByLabelText(`整组标定相机 ${index + 1} SN`), {
        target: { value: `SN-${index + 1}` },
      });
      fireEvent.change(screen.getByLabelText(`整组标定相机 ${index + 1} 回滚文件`), {
        target: { value: `D:/cal/known-good-cam${index + 1}.xml` },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'dryRun 预检' }));

    await waitFor(() => expect(api.applyCaptureCalibrationSet).toHaveBeenCalledWith(expect.objectContaining({
      dryRun: true,
      operationId: undefined,
      atomic: true,
      rollbackOnFailure: true,
      saveToDevice: false,
      allowExternal: false,
    })));
    expect(await screen.findByText('当前配置已通过预检')).toBeInTheDocument();
    expect(screen.getByText('preflight passed; no SDK call made')).toBeInTheDocument();
    const applyReconciliation = screen.getByLabelText('标定应用操作对账');
    const applyOperationId = within(applyReconciliation).getAllByRole('definition')[0].textContent || '';
    expect(applyOperationId).not.toBe('');

    fireEvent.change(screen.getByLabelText('整组标定应用确认短语'), { target: { value: CAMERA_CALIBRATION_SET_CONFIRMATION } });
    fireEvent.click(screen.getByRole('button', { name: '原子应用整组标定' }));
    await waitFor(() => expect(api.applyCaptureCalibrationSet).toHaveBeenLastCalledWith(expect.objectContaining({
      dryRun: false,
      operationId: applyOperationId,
    })));
    expect(await screen.findByDisplayValue('rollback-1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '刷新应用对账' }));
    await waitFor(() => expect(api.readCaptureCalibrationOperationDetail).toHaveBeenCalledWith(applyOperationId));
    expect(within(applyReconciliation).getByText('succeeded')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('整组标定回滚确认短语'), { target: { value: CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION } });
    fireEvent.click(screen.getByRole('button', { name: '回滚整组标定' }));
    await waitFor(() => expect(api.rollbackCaptureCalibrationSet).toHaveBeenCalledWith(expect.objectContaining({
      rollbackToken: 'rollback-1',
      operationId: expect.any(String),
      parentOperationId: undefined,
      confirmation: CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION,
    })));
    const rollbackReconciliation = screen.getByLabelText('标定回滚操作对账');
    expect(within(rollbackReconciliation).getByText('否')).toBeInTheDocument();
  });

  it('uses the 423 fence evidence for a parent-bound recovery and shows durable reconciliation fields', async () => {
    api.applyCaptureCalibrationSet.mockImplementation(async (input: { dryRun: boolean }) => {
      if (input.dryRun) {
        return { code: 0, dryRun: true, results: [] };
      }
      throw new CaptureAdminApiError(
        'capture api 423：423 calibration_reconciliation_required',
        423,
        {
          code: 423,
          error: 'calibration_reconciliation_required',
          unresolvedOperations: [{
            operationId: 'apply-pending-42',
            kind: 'apply',
            status: 'needs-reconciliation',
            updatedAt: '2026-07-12T02:00:00Z',
          }],
        },
      );
    });
    api.rollbackCaptureCalibrationSet.mockResolvedValue({ code: 0, complete: true });
    api.readCaptureCalibrationOperationDetail.mockResolvedValue({
      code: 0,
      operationId: 'apply-pending-42',
      kind: 'apply',
      status: 'reconciled',
      needsReconciliation: false,
      parentOperationId: null,
      reconciliationOutcome: 'restored-to-staged-baseline',
      reconciliationId: 'rollback-recovery-42',
      resolvedBy: 'admin-operator',
      resolvedAt: '2026-07-12T02:10:00Z',
      rowVersion: 3,
    });
    render(<CaptureDiagnosticOperations cameraIps={cameraIps} />);

    cameraIps.forEach((_, index) => {
      fireEvent.change(screen.getByLabelText(`整组标定相机 ${index + 1} SDK 文件`), {
        target: { value: `D:/cal/cam${index + 1}.xml` },
      });
      fireEvent.change(screen.getByLabelText(`整组标定相机 ${index + 1} SN`), {
        target: { value: `SN-${index + 1}` },
      });
      fireEvent.change(screen.getByLabelText(`整组标定相机 ${index + 1} 回滚文件`), {
        target: { value: `D:/cal/known-good-cam${index + 1}.xml` },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'dryRun 预检' }));
    await screen.findByText('当前配置已通过预检');
    fireEvent.change(screen.getByLabelText('整组标定应用确认短语'), {
      target: { value: CAMERA_CALIBRATION_SET_CONFIRMATION },
    });
    fireEvent.click(screen.getByRole('button', { name: '原子应用整组标定' }));

    const fence = await screen.findByRole('alert');
    expect(fence).toHaveTextContent('HTTP 423 标定协调围栏已生效');
    expect(fence).toHaveTextContent('apply-pending-42');
    expect(screen.getByText(/HTTP 423 标定协调围栏已锁定设备变更/)).toBeInTheDocument();
    const applyPanel = screen.getByLabelText('标定应用操作对账');
    expect(within(applyPanel).getByText('apply-pending-42')).toBeInTheDocument();
    expect(within(applyPanel).getByText('needs-reconciliation')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /标记.*(?:成功|失败)/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('整组标定回滚 token'), {
      target: { value: 'rollback-token-pending' },
    });
    fireEvent.change(screen.getByLabelText('整组标定回滚确认短语'), {
      target: { value: CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION },
    });
    fireEvent.click(screen.getByRole('button', { name: '受控恢复并协调整组标定' }));

    await waitFor(() => expect(api.rollbackCaptureCalibrationSet).toHaveBeenCalledWith(expect.objectContaining({
      rollbackToken: 'rollback-token-pending',
      operationId: expect.any(String),
      applyOperationId: 'apply-pending-42',
      parentOperationId: 'apply-pending-42',
      confirmation: CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION,
    })));
    await waitFor(() => expect(api.readCaptureCalibrationOperationDetail).toHaveBeenCalledWith('apply-pending-42'));
    expect(await screen.findByText('restored-to-staged-baseline')).toBeInTheDocument();
    expect(within(applyPanel).getByText('rollback-recovery-42')).toBeInTheDocument();
    expect(within(applyPanel).getByText('admin-operator')).toBeInTheDocument();
    expect(within(applyPanel).getByText('2026-07-12T02:10:00Z')).toBeInTheDocument();
    expect(within(applyPanel).getByText('3')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps apply and rollback operation IDs stable across timeout retries and clears them only with payload changes', async () => {
    api.applyCaptureCalibrationSet.mockImplementation(async (input: { dryRun: boolean }) => {
      if (input.dryRun) {
        return { code: 0, dryRun: true, results: [] };
      }
      throw new Error('apply timeout');
    });
    api.rollbackCaptureCalibrationSet.mockRejectedValue(new Error('rollback timeout'));
    render(<CaptureDiagnosticOperations cameraIps={cameraIps} />);

    cameraIps.forEach((_, index) => {
      fireEvent.change(screen.getByLabelText(`整组标定相机 ${index + 1} SDK 文件`), {
        target: { value: `D:/cal/cam${index + 1}.xml` },
      });
      fireEvent.change(screen.getByLabelText(`整组标定相机 ${index + 1} SN`), {
        target: { value: `SN-${index + 1}` },
      });
      fireEvent.change(screen.getByLabelText(`整组标定相机 ${index + 1} 回滚文件`), {
        target: { value: `D:/cal/known-good-cam${index + 1}.xml` },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'dryRun 预检' }));
    const applyPanel = await screen.findByLabelText('标定应用操作对账');
    const applyOperationId = within(applyPanel).getAllByRole('definition')[0].textContent || '';

    fireEvent.change(screen.getByLabelText('整组标定应用确认短语'), {
      target: { value: CAMERA_CALIBRATION_SET_CONFIRMATION },
    });
    fireEvent.click(screen.getByRole('button', { name: '原子应用整组标定' }));
    await screen.findByText('apply timeout');
    expect(within(applyPanel).getByText('unknown')).toBeInTheDocument();
    expect(within(applyPanel).getByText('是')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '原子应用整组标定' }));
    await waitFor(() => expect(api.applyCaptureCalibrationSet).toHaveBeenCalledTimes(3));
    const realApplyCalls = api.applyCaptureCalibrationSet.mock.calls
      .map(([input]) => input)
      .filter((input) => input.dryRun === false);
    expect(realApplyCalls.map((input) => input.operationId)).toEqual([
      applyOperationId,
      applyOperationId,
    ]);

    fireEvent.click(screen.getByRole('button', { name: '新建标定操作 / 重新预检' }));
    await waitFor(() => expect(api.applyCaptureCalibrationSet).toHaveBeenCalledTimes(4));
    const renewedApplyPanel = await screen.findByLabelText('标定应用操作对账');
    const renewedOperationId = within(renewedApplyPanel).getAllByRole('definition')[0].textContent || '';
    expect(renewedOperationId).not.toBe(applyOperationId);

    fireEvent.change(screen.getByLabelText('整组标定 Profile'), {
      target: { value: 'changed-profile' },
    });
    expect(screen.queryByLabelText('标定应用操作对账')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('整组标定回滚 token'), {
      target: { value: 'rollback-token-timeout' },
    });
    fireEvent.change(screen.getByLabelText('整组标定回滚原 apply operationId'), {
      target: { value: renewedOperationId },
    });
    fireEvent.change(screen.getByLabelText('整组标定回滚确认短语'), {
      target: { value: CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION },
    });
    fireEvent.click(screen.getByRole('button', { name: '回滚整组标定' }));
    await screen.findByText('rollback timeout');
    const rollbackPanel = screen.getByLabelText('标定回滚操作对账');
    const rollbackOperationId = within(rollbackPanel).getAllByRole('definition')[0].textContent || '';

    fireEvent.click(screen.getByRole('button', { name: '回滚整组标定' }));
    await waitFor(() => expect(api.rollbackCaptureCalibrationSet).toHaveBeenCalledTimes(2));
    expect(api.rollbackCaptureCalibrationSet.mock.calls.map(([input]) => input.operationId)).toEqual([
      rollbackOperationId,
      rollbackOperationId,
    ]);

    fireEvent.change(screen.getByLabelText('整组标定回滚 token'), {
      target: { value: 'different-token' },
    });
    expect(screen.queryByLabelText('标定回滚操作对账')).not.toBeInTheDocument();
  });

  it('uses safe line-preset defaults and invalidates confirmation whenever the payload changes', async () => {
    render(<CaptureDiagnosticOperations cameraIps={cameraIps} />);

    fireEvent.change(screen.getByLabelText('线扫预设确认短语'), { target: { value: LINE_PRESET_CONFIRMATION } });
    fireEvent.click(screen.getByRole('button', { name: '应用线扫预设' }));
    await waitFor(() => expect(api.applyCaptureLineContinuousPreset).toHaveBeenCalledWith(expect.objectContaining({
      connectFirst: false,
      saveToDevice: false,
      confirmation: LINE_PRESET_CONFIRMATION,
      deviceConfirmation: undefined,
    })));

    fireEvent.change(screen.getByLabelText('线扫预设确认短语'), { target: { value: LINE_PRESET_CONFIRMATION } });
    fireEvent.change(screen.getByLabelText('线扫预设触发行数'), { target: { value: '1200' } });
    expect(screen.getByRole('button', { name: '应用线扫预设' })).toBeDisabled();

    fireEvent.click(screen.getByLabelText('线扫预设持久化到设备'));
    fireEvent.change(screen.getByLabelText('线扫预设确认短语'), { target: { value: LINE_PRESET_CONFIRMATION } });
    fireEvent.change(screen.getByLabelText('线扫预设设备持久化确认短语'), { target: { value: LINE_PRESET_DEVICE_CONFIRMATION } });
    fireEvent.click(screen.getByRole('button', { name: '应用线扫预设' }));
    await waitFor(() => expect(api.applyCaptureLineContinuousPreset).toHaveBeenLastCalledWith(expect.objectContaining({
      lines: 1200,
      saveToDevice: true,
      deviceConfirmation: LINE_PRESET_DEVICE_CONFIRMATION,
    })));
  });
});
