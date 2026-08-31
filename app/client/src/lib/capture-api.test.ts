import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCaptureCameraStorageRoots,
  applyCaptureCalibrationSet,
  applyCaptureContinuousSettings,
  applyCaptureLineContinuousPreset,
  applyCaptureProfile,
  activateCaptureCalibration,
  CAMERA_CALIBRATION_CONFIRMATION,
  CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION,
  CAMERA_ROI_CONFIRMATION,
  CaptureAdminApiError,
  calculateSystemNetworkRates,
  captureHistoryImageUrl,
  captureRenderImageUrl,
  captureStreamImageUrl,
  chooseCaptureLocalDirectory,
  chooseCaptureLocalFile,
  connectCaptureCamera,
  disconnectCaptureCamera,
  importCaptureProfileFromProviderPath,
  loadAllCaptureCameraParams,
  loadCaptureCalibration,
  loadCaptureParamFile,
  loadCaptureRoi,
  persistAllCaptureCameraParams,
  persistCaptureParamsToDevice,
  readCaptureProfile,
  readCaptureProfiles,
  readCaptureSnapshot,
  readCaptureCalibrationOperationDetail,
  readCaptureContinuousSettings,
  readCaptureDefects,
  readCaptureHistory,
  readCapturePlaybackCacheStatus,
  readCaptureMeasurement,
  readCaptureSurface,
  readCaptureParam,
  readCaptureLocalTextFile,
  readActiveCaptureCalibration,
  readLatestCaptureFile,
  rebuildCaptureMeasurement,
  rebuildCaptureDefects,
  runCaptureContinuousTest,
  recoverCaptureCameraParams,
  rollbackCaptureCalibrationSet,
  saveCaptureParamFile,
  saveCapturePreviewFromUrl,
  saveCaptureProfile,
  saveAllCaptureCameraParams,
  setCaptureParam,
  setCaptureSoftwareTrigger,
  startCaptureStream,
  stopCaptureStream,
  validateCaptureContinuousSettings,
  writeCaptureParam,
  type SystemNetworkSnapshot,
} from "./capture-api";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function snapshot(
  sampledAtMs: number,
  receivedBytes: number,
  transmittedBytes: number,
): SystemNetworkSnapshot {
  return {
    code: 0,
    source: "test",
    sampledAtMs,
    totalReceivedBytes: receivedBytes,
    totalTransmittedBytes: transmittedBytes,
    interfaces: [
      {
        index: 1,
        name: "Ethernet 1",
        description: "Camera NIC",
        status: "Up",
        linkSpeed: "1 Gbps",
        linkSpeedBitsPerSecond: 1_000_000_000,
        receivedBytes,
        transmittedBytes,
        packetsReceived: 100,
        packetsTransmitted: 80,
      },
    ],
  };
}

describe("calculateSystemNetworkRates", () => {
  it("calculates real-time upload and download Mbps from consecutive byte counters", () => {
    const previous = snapshot(1_000, 1_000_000, 2_000_000);
    const current = snapshot(2_000, 26_000_000, 14_500_000);
    current.interfaces[0].ipv4Addresses = "192.168.101.10/24";

    const rates = calculateSystemNetworkRates(current, previous);

    expect(rates.interfaces).toHaveLength(1);
    expect(rates.interfaces[0].downloadMbps).toBe(200);
    expect(rates.interfaces[0].uploadMbps).toBe(100);
    expect(rates.interfaces[0].bandwidthMbps).toBe(1000);
    expect(rates.interfaces[0].online).toBe(true);
    expect(rates.interfaces[0].ipv4Addresses).toEqual(["192.168.101.10/24"]);
    expect(rates.totalDownloadMbps).toBe(200);
    expect(rates.totalUploadMbps).toBe(100);
  });

  it("keeps the first sample at zero speed until a second counter sample exists", () => {
    const rates = calculateSystemNetworkRates(
      snapshot(1_000, 26_000_000, 14_500_000),
      null,
    );

    expect(rates.totalDownloadMbps).toBe(0);
    expect(rates.totalUploadMbps).toBe(0);
  });

  it("clamps reset or wrapped counters to zero instead of showing negative speed", () => {
    const previous = snapshot(2_000, 26_000_000, 14_500_000);
    const current = snapshot(3_000, 1_000_000, 2_000_000);

    const rates = calculateSystemNetworkRates(current, previous);

    expect(rates.totalDownloadMbps).toBe(0);
    expect(rates.totalUploadMbps).toBe(0);
  });

  it("uses API-provided real-time rates when they are present on the current sample", () => {
    const current = snapshot(1_000, 26_000_000, 14_500_000);
    current.interfaces[0].uploadMbps = 12.5;
    current.interfaces[0].downloadMbps = 98.25;
    current.interfaces[0].bandwidthMbps = 2500;
    current.interfaces[0].online = true;

    const rates = calculateSystemNetworkRates(current, null);

    expect(rates.interfaces[0].uploadMbps).toBe(12.5);
    expect(rates.interfaces[0].downloadMbps).toBe(98.25);
    expect(rates.interfaces[0].bandwidthMbps).toBe(2500);
    expect(rates.interfaces[0].online).toBe(true);
    expect(rates.totalUploadMbps).toBe(12.5);
    expect(rates.totalDownloadMbps).toBe(98.25);
  });

  it("keeps API-provided zero real-time rates instead of replacing them with local deltas", () => {
    const previous = snapshot(1_000, 1_000_000, 2_000_000);
    const current = snapshot(2_000, 26_000_000, 14_500_000);
    current.interfaces[0].uploadMbps = 0;
    current.interfaces[0].downloadMbps = 0;

    const rates = calculateSystemNetworkRates(current, previous);

    expect(rates.interfaces[0].uploadMbps).toBe(0);
    expect(rates.interfaces[0].downloadMbps).toBe(0);
    expect(rates.totalUploadMbps).toBe(0);
    expect(rates.totalDownloadMbps).toBe(0);
  });

  it("uses API-provided total real-time rates when the backend reports aggregate speeds", () => {
    const current = snapshot(1_000, 26_000_000, 14_500_000);
    current.interfaces[0].uploadMbps = 12.5;
    current.interfaces[0].downloadMbps = 98.25;
    current.totalUploadMbps = 16;
    current.totalDownloadMbps = 128;
    current.totalBandwidthMbps = 2500;

    const rates = calculateSystemNetworkRates(current, null);

    expect(rates.totalUploadMbps).toBe(16);
    expect(rates.totalDownloadMbps).toBe(128);
    expect(rates.totalBandwidthMbps).toBe(2500);
  });
});

describe("readCaptureSnapshot", () => {
  it("uses the active SICK GenTL identity instead of the legacy LVM fallback", async () => {
    const camera = {
      cameraIndex: 1,
      cameraId: "C1",
      name: "C1",
      role: "sick-405-1",
      ip: "192.168.101.144",
      model: "Ranger3-60",
      sn: "25440062",
      driverId: "sick-gentl-harvesters",
      connected: true,
      acquiring: true,
      continuousAcquiring: true,
      continuousFps: 3.9,
      deviceId: 1,
      configId: "C1",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.endsWith("/api/config")
        ? { capture: { mode: "sick-array-6", driver: "sick-gentl", cameras: [] } }
        : url.endsWith("/api/capture/health")
          ? {
              service: "steel_sick_capture_sidecar",
              time: "2026-08-24T02:00:00Z",
              provider: "external-api",
              sdkReady: true,
              sdkCode: 0,
              connected: true,
              ip: camera.ip,
              driverId: "sick-gentl-harvesters",
              driverName: "SICK GenTL Producer via Harvesters",
              cameraCount: 1,
              expectedCameras: 1,
            }
          : url.endsWith("/api/cameras")
            ? { cameras: [camera] }
            : url.endsWith("/api/camera/statuses")
              ? { statuses: [camera] }
              : url.endsWith("/api/camera/status")
                ? camera
                : { events: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await readCaptureSnapshot();

    expect(result.driver).toMatchObject({
      id: "sick-gentl-harvesters",
      name: "SICK GenTL Producer via Harvesters",
      vendor: "SICK",
      transport: "GigE Vision / GenTL",
      supportedModels: ["Ranger3-60"],
    });
    expect(result.driver.name).not.toContain("LVM");
  });
});

describe("readLatestCaptureFile", () => {
  it("reads latest image metadata through Rust and resolves the proxied image URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          ip: "192.168.101.100",
          kind: "intensity",
          path: "H:/camera3/BAR-001/intensity/000001.png",
          url: "/api/capture/file?path=H%3A%2Fcamera3%2FBAR-001%2Fintensity%2F000001.png",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Date, "now").mockReturnValue(1783771200000);

    const latest = await readLatestCaptureFile("192.168.101.100", "intensity");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4873/api/capture/latest?ip=192.168.101.100&kind=intensity&meta=1",
    );
    expect(latest.imageUrl).toBe(
      "http://127.0.0.1:4873/api/capture/file?path=H%3A%2Fcamera3%2FBAR-001%2Fintensity%2F000001.png&v=1783771200000",
    );
  });

  it("keeps realtime controls on Rust and reads frame bytes from the loopback data plane", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ code: 0, ip: "192.168.101.100", running: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Date, "now").mockReturnValue(1783771200123);
    const startController = new AbortController();
    const stopController = new AbortController();

    await startCaptureStream({
      ip: "192.168.101.100",
      lines: 1000,
      width: 4096,
      dataMode: 1,
      fpsLimit: 12,
      hs: true,
    }, startController.signal);
    await stopCaptureStream("192.168.101.100", stopController.signal);

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:4873/api/stream/start");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      ip: "192.168.101.100",
      lines: 1000,
      width: 4096,
      dataMode: 1,
      fpsLimit: 12,
      hs: true,
    });
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(startController.signal);
    expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:4873/api/stream/stop");
    expect(fetchMock.mock.calls[1][1]?.signal).toBe(stopController.signal);
    expect(captureStreamImageUrl("192.168.101.100", "intensity")).toBe(
      "http://127.0.0.1:4317/api/stream/latest?ip=192.168.101.100&kind=intensity&region=valid&v=1783771200123",
    );
  });

  it("keeps live preview images on the inspection proxy for a LAN client", () => {
    window.localStorage.setItem("steel-inspection-connection-config", JSON.stringify({
      mode: "online",
      host: "192.168.10.25",
      port: 4873,
    }));

    expect(captureStreamImageUrl("192.168.101.100", "intensity", 42)).toBe(
      "http://192.168.10.25:4873/api/stream/latest?ip=192.168.101.100&kind=intensity&region=valid&v=42",
    );
  });

  it("reads capture history and requests a pixel-bounded playback image", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      code: 0,
      storageRoot: "D:\\steel-sick-data",
      total: 1,
      count: 1,
      hasMore: false,
      frames: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);

    await readCaptureHistory(999);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4317/api/capture/history?limit=500",
      { headers: { Accept: "application/json" }, signal: undefined },
    );
    expect(captureHistoryImageUrl("63/capture/C1/2d/1.png", 8192, [0, 0, 2560, 1280])).toBe(
      "http://127.0.0.1:4873/api/capture/file?path=63%2Fcapture%2FC1%2F2d%2F1.png&maxWidth=4096&region=valid&cropX=0&cropY=0&cropWidth=2560&cropHeight=1280",
    );
    expect(captureHistoryImageUrl("63/capture/C1/2d/1.png", 2048, [665, 0, 1144, 1024])).toBe(
      "http://127.0.0.1:4873/api/capture/file?path=63%2Fcapture%2FC1%2F2d%2F1.png&maxWidth=2048&region=valid&cropX=665&cropY=0&cropWidth=479&cropHeight=1024",
    );
    expect(captureRenderImageUrl("63/capture/C1/2d/1.png", "gray", "thumbnail")).toBe(
      "http://127.0.0.1:4317/api/capture/render?path=63%2Fcapture%2FC1%2F2d%2F1.png&modality=gray&level=thumbnail",
    );
    expect(captureRenderImageUrl("63/capture/C1/2d/1.png", "jet", "original")).toBe(
      "http://127.0.0.1:4317/api/capture/render?path=63%2Fcapture%2FC1%2F2d%2F1.png&modality=jet&level=original",
    );

    await readCapturePlaybackCacheStatus();
    expect(fetchMock.mock.calls[1][0]).toBe(
      "http://127.0.0.1:4873/api/capture/cache/status",
    );
  });

  it("binds capture history to the selected numeric material flow", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      storageRoot: "D:\\steel-sick-data",
      total: 0,
      count: 0,
      hasMore: false,
      indexed: true,
      frames: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    await readCaptureHistory(500, " 2747 ", controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4317/api/capture/history?limit=500&materialId=2747",
      { headers: { Accept: "application/json" }, signal: controller.signal },
    );
  });

  it("reads and rebuilds the selected flow measurement through Rust", async () => {
    const responseBody = JSON.stringify({
      code: 0,
      path: "D:\\steel-sick-data\\1\\derived\\geometry\\measurement.json",
      measurement: {
        schema: "steel.ranger3-flow-measurement.v1",
        generatedAt: "2026-08-22T04:00:00Z",
        materialId: "1",
        mode: "preview",
        metricValid: false,
        qualityGate: { passed: false, reasons: ["approved-array-calibration-missing"] },
        selectedSection: {},
        cameras: {},
      },
    });
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(responseBody, { status: 200, headers: { "Content-Type": "application/json" } }),
    ));
    vi.stubGlobal("fetch", fetchMock);

    await readCaptureMeasurement("1");
    await rebuildCaptureMeasurement("1");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:4873/api/capture/measurement?materialId=1",
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "http://127.0.0.1:4873/api/capture/measurement/rebuild",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      materialId: "1",
    });
  });

  it("reads the synchronized JET surface through Rust", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      path: "D:\\steel-sick-data\\1\\derived\\geometry\\surface.json",
      surface: { schema: "steel.ranger3-flow-surface.v1", materialId: "1" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await readCaptureSurface("1");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:4873/api/capture/surface?materialId=1",
    );
  });

  it("reads and rebuilds temporary defect detection through Rust", async () => {
    const responseBody = JSON.stringify({
      code: 0,
      path: "D:\\steel-sick-data\\1\\derived\\defects\\manifest.json",
      detection: {
        schema: "steel.sick-flow-defect-detection.v1",
        generatedAt: "2026-08-22T10:00:00Z",
        materialId: "1",
        state: "complete",
        temporaryModel: true,
        quality: { reviewRequired: true, fineGrainedClassification: false },
        defects: [],
      },
    });
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(responseBody, { status: 200, headers: { "Content-Type": "application/json" } }),
    ));
    vi.stubGlobal("fetch", fetchMock);

    await readCaptureDefects("1");
    await rebuildCaptureDefects("1");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:4873/api/capture/defects?materialId=1",
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "http://127.0.0.1:4873/api/capture/defects/rebuild",
    );
  });

  it("rejects out-of-range realtime preview parameters before dispatch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(startCaptureStream({ ip: "192.168.101.100", width: 32769 }))
      .rejects.toThrow("宽度必须是 0 到 32768");
    await expect(startCaptureStream({ ip: "192.168.101.100", dataMode: 2 }))
      .rejects.toThrow("数据模式只允许 1");
    await expect(startCaptureStream({ ip: "192.168.101.100", fpsLimit: 31 }))
      .rejects.toThrow("FPS 限制必须是 1 到 30");
    await expect(startCaptureStream({
      ip: "192.168.101.100",
      hs: "yes" as unknown as boolean,
    })).rejects.toThrow("高速模式必须是布尔值");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads and applies continuous acquisition settings through Rust without persisting camera parameters", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/capture/continuous-settings') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          code: 0,
          applyToDevice: true,
          dryRun: false,
          restartContinuous: true,
          productionCaptureRestarted: true,
          timeTriggerFreq: 360.5,
          lineTriggerFrequency: 360.5,
          applied: 2,
          failed: 0,
          results: [
            { code: 0, ip: '192.168.101.100', applied: true, timeTriggerFreq: 360.5 },
            { code: 0, ip: '192.168.102.100', applied: true, timeTriggerFreq: 360.5 },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        code: 0,
        settings: {
          supported: true,
          connectedCameras: 8,
          configuredCameras: 8,
          timeTriggerFreq: 300,
          lineTriggerFrequency: 300,
          requiresApplyToDevice: true,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const current = await readCaptureContinuousSettings();
    const applied = await applyCaptureContinuousSettings({
      timeTriggerFreq: 360.5,
      ips: [' 192.168.101.100 ', '192.168.102.100'],
      applyToDevice: true,
      restartContinuous: true,
    });

    expect(current.settings?.lineTriggerFrequency).toBe(300);
    expect(applied.lineTriggerFrequency).toBe(360.5);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4873/api/capture/continuous-settings');
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:4873/api/capture/continuous-settings');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      timeTriggerFreq: 360.5,
      ips: ['192.168.101.100', '192.168.102.100'],
      applyToDevice: true,
      restartContinuous: true,
    });
  });

  it("validates the production line trigger rate before calling the capture service", async () => {
    expect(validateCaptureContinuousSettings({ timeTriggerFreq: 0.09 })).toContain('0.1 到 100000 Hz');
    expect(validateCaptureContinuousSettings({ timeTriggerFreq: 100000.1 })).toContain('0.1 到 100000 Hz');
    expect(validateCaptureContinuousSettings({ timeTriggerFreq: 300, ips: [''] })).toContain('空相机 IP');
  });

  it("reads and activates reviewed array calibration without writing camera devices", async () => {
    window.localStorage.setItem(
      "steel-inspection-admin-session",
      JSON.stringify({ token: "calibration-admin-token", user: { id: "admin" } }),
    );
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          code: 0,
          profile: "current-8-time-trigger",
          calibrationFile: "config/calibrations/reviewed/ArrayCalibration.corrected.xml",
          calibrationPath: "E:/steel-capture-data/config/calibrations/reviewed/ArrayCalibration.corrected.xml",
          exists: true,
          activeCalibration: { version: "reviewed", saveToDevice: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await readActiveCaptureCalibration();
    await activateCaptureCalibration({
      name: "current-8-time-trigger",
      path: "E:/steel-capture-data/analysis/reviewed/ArrayCalibration.corrected.xml",
      allowExternal: true,
      saveToDevice: false,
      appliedBy: "tauri-calibration-review",
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:4873/api/calibration/active",
    );
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: "Bearer calibration-admin-token",
    });
    expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:4873/api/calibration/active");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      allowExternal: true,
      saveToDevice: false,
      appliedBy: "tauri-calibration-review",
    });
  });
});

describe("capture operations migrated from Qt", () => {
  it("requires the stored admin session for camera connect and disconnect", async () => {
    window.localStorage.setItem(
      "steel-inspection-admin-session",
      JSON.stringify({ token: "camera-admin-token", user: { id: "admin" } }),
    );
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await connectCaptureCamera("192.168.101.100");
    await disconnectCaptureCamera("192.168.101.100");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:4873/api/camera/connect",
      "http://127.0.0.1:4873/api/camera/disconnect",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        headers: {
          Authorization: "Bearer camera-admin-token",
        },
      });
    }
  });

  it("uses the stored admin session for profile reads", async () => {
    window.localStorage.setItem(
      "steel-inspection-admin-session",
      JSON.stringify({ token: "admin-token", user: { id: "admin" } }),
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          activeProfile: "current-6-soft-trigger",
          profiles: ["current-6-soft-trigger"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await readCaptureProfiles();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4873/api/config/profiles",
      {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer admin-token",
        },
      },
    );
  });

  it("keeps profile and parameter-file operations non-persistent on camera devices", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 0, failed: 0, results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await applyCaptureProfile({
      name: "current-6-soft-trigger",
      autoConnect: true,
      loadCameraParams: false,
      changeStorage: false,
      saveToDevice: false,
    });
    await saveAllCaptureCameraParams({
      name: "current-6-soft-trigger",
      applySoftTrigger: false,
      saveToDevice: false,
    });
    await loadAllCaptureCameraParams({
      name: "current-6-soft-trigger",
      cameraParamDir: "config/camera-params/current-6-soft-trigger",
      applySoftTrigger: false,
      saveToDevice: false,
      allowExternal: false,
    });

    const payloads = fetchMock.mock.calls.map((call) =>
      JSON.parse(String((call[1] as RequestInit).body)),
    );
    expect(payloads[0]).toMatchObject({
      name: "current-6-soft-trigger",
      saveToDevice: false,
      loadCameraParams: false,
      changeStorage: false,
    });
    expect(payloads[1]).toMatchObject({
      applySoftTrigger: false,
      saveToDevice: false,
    });
    expect(payloads[2]).toMatchObject({
      applySoftTrigger: false,
      saveToDevice: false,
      allowExternal: false,
    });
  });

  it("reads, saves and imports provider-side profiles through the Rust admin proxy", async () => {
    window.localStorage.setItem(
      "steel-inspection-admin-session",
      JSON.stringify({ token: "profile-admin-token", user: { id: "admin" } }),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/config/profile?")) {
        return new Response(
          JSON.stringify({
            schema: "steel.capture.profile.v1",
            name: "maintenance-review",
            saveToDevice: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          code: 0,
          name: "maintenance-review",
          path: "D:/capture/config/profiles/maintenance-review/profile.json",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const profile = await readCaptureProfile("maintenance review");
    await saveCaptureProfile({
      name: "maintenance-review",
      profile,
      makeActive: false,
    });
    await importCaptureProfileFromProviderPath({
      path: "D:/offline/profiles/reviewed",
      name: "reviewed-import",
      overwrite: false,
      makeActive: false,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:4873/api/config/profile?name=maintenance+review",
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: {
        Accept: "application/json",
        Authorization: "Bearer profile-admin-token",
      },
    });
    const savePayload = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(savePayload).toMatchObject({
      name: "maintenance-review",
      makeActive: false,
    });
    expect(JSON.parse(savePayload.profileJson)).toMatchObject({
      name: "maintenance-review",
      saveToDevice: false,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({
      path: "D:/offline/profiles/reviewed",
      name: "reviewed-import",
      overwrite: false,
      makeActive: false,
    });
    expect(fetchMock.mock.calls[2][0]).toBe(
      "http://127.0.0.1:4873/api/config/profile/import",
    );
  });

  it("applies per-camera roots and runs a structured continuous test with safe flags", async () => {
    window.localStorage.setItem(
      "steel-inspection-admin-session",
      JSON.stringify({ token: "capture-admin-token", user: { id: "admin" } }),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/storage/camera-roots")) {
        return new Response(
          JSON.stringify({
            code: 0,
            root: "H:/",
            exists: true,
            writable: true,
            cameraRoots: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          schema: "steel.capture.continuous-test.summary.v1",
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
          results: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await applyCaptureCameraStorageRoots({
      replace: true,
      cameraRoots: [
        { ip: " 192.168.101.100 ", root: " H:/camera3 " },
        { ip: "192.168.102.100", root: "H:/camera2" },
      ],
    });
    const summary = await runCaptureContinuousTest({
      expectedCameras: 2,
      rounds: 1,
      lines: 1000,
      width: 0,
      timeoutMs: 8000,
      intervalMs: 250,
      retries: 0,
      dataMode: 3,
      outputDir: "continuous-test/tauri",
      connectFirst: false,
      stopStreams: true,
      ips: ["192.168.101.100", "192.168.102.100"],
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      replace: true,
      cameraRoots: [
        { ip: "192.168.101.100", root: "H:/camera3" },
        { ip: "192.168.102.100", root: "H:/camera2" },
      ],
    });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: {
        Accept: "application/json",
        Authorization: "Bearer capture-admin-token",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      expectedCameras: 2,
      rounds: 1,
      controlMode: 0,
      dataMode: 3,
      discardBlackFrames: true,
      saveSdkDerived: false,
      stopStreams: true,
    });
    expect(summary.expectedMet).toBe(true);
    expect(summary.parallel).toBe(true);
  });

  it("sends live parameter changes through the Rust admin-config boundary", async () => {
    window.localStorage.setItem(
      "steel-inspection-admin-session",
      JSON.stringify({ token: "parameter-admin-token", user: { id: "admin" } }),
    );
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ code: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await setCaptureSoftwareTrigger("192.168.101.100");
    await setCaptureParam(
      "ExposureTime",
      "int",
      850,
      "192.168.101.100",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("http://127.0.0.1:4873/api/param");
      expect(call[1]?.headers).toMatchObject({
        Accept: "application/json",
        Authorization: "Bearer parameter-admin-token",
        "Content-Type": "application/json",
      });
    }
  });

  it("locks diagnostic SDK, calibration, rollback and persistence requests to backend confirmation contracts", async () => {
    window.localStorage.setItem(
      "steel-inspection-admin-session",
      JSON.stringify({ token: "diagnostic-admin-token", user: { id: "admin" } }),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(String(input).includes("/api/calibration/operations/detail")
        ? { code: 0, operationId: "apply-operation-1", status: "needs-reconciliation" }
        : { code: 0, dryRun: true, results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await readCaptureParam(" 192.168.101.100 ", " ExposureTime ", "int");
    await writeCaptureParam({ ip: " 192.168.101.100 ", key: " VendorKey ", type: "int", value: 12 });
    await recoverCaptureCameraParams("192.168.101.100");
    await loadCaptureCalibration({
      ip: "192.168.101.100",
      path: "D:/cal/cam1.xml",
      allowExternal: true,
      confirmation: CAMERA_CALIBRATION_CONFIRMATION,
    });
    await loadCaptureRoi({
      ip: "192.168.101.100",
      path: "D:/cal/cam1-roi.xml",
      allowExternal: true,
      confirmation: CAMERA_ROI_CONFIRMATION,
    });
    const calibrationMappings = Array.from({ length: 8 }, (_, index) => ({
      ip: `192.168.${101 + index}.100`,
      path: `D:/cal/cam${index + 1}.xml`,
      expectedSn: `SN-${index + 1}`,
      rollbackPath: `D:/cal/known-good-cam${index + 1}.xml`,
    }));
    await applyCaptureCalibrationSet({
      name: "current-8-time-trigger",
      cameraCalibrations: calibrationMappings,
      dryRun: true,
      saveToDevice: false,
    });
    await applyCaptureCalibrationSet({
      name: "current-8-time-trigger",
      cameraCalibrations: calibrationMappings,
      dryRun: false,
      saveToDevice: true,
      operationId: "apply-operation-1",
      confirmation: "APPLY CAMERA CALIBRATION SET",
      deviceConfirmation: "PERSIST CAMERA PARAMETERS",
    });
    await rollbackCaptureCalibrationSet({
      rollbackToken: " rollback-token-1 ",
      operationId: "rollback-operation-1",
      applyOperationId: "apply-operation-1",
      confirmation: CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION,
    });
    const operationDetail = await readCaptureCalibrationOperationDetail(" apply-operation-1 ");
    expect(operationDetail.needsReconciliation).toBe(true);
    await applyCaptureLineContinuousPreset({
      lines: 1000,
      timeTriggerFreq: 300,
      laserPower: 100,
      laserLineSelect: 0,
      controlMode: 0,
      confirmation: "APPLY LINE CONTINUOUS PRESET",
    });
    await loadCaptureParamFile({
      ip: "192.168.101.100",
      path: "D:/params/cam1.nccfg",
      allowExternal: true,
      saveToDevice: true,
    });
    await saveCaptureParamFile({ ip: "192.168.101.100", path: "param-backup/cam1.nccfg" });
    await persistCaptureParamsToDevice("192.168.101.100");
    await persistAllCaptureCameraParams({
      name: "current-6-soft-trigger",
      ips: ["192.168.101.100"],
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:4873/api/param?ip=192.168.101.100&key=ExposureTime&type=int",
    );
    const calls = fetchMock.mock.calls.slice(1).map(([url, init]) => ({
      url: String(url),
      body: (init as RequestInit | undefined)?.body
        ? JSON.parse(String((init as RequestInit).body))
        : undefined,
    }));
    expect(calls[0].body).toMatchObject({
      ip: "192.168.101.100",
      key: "VendorKey",
      confirmation: "WRITE SDK PARAMETER",
    });
    expect(calls[1].body).toMatchObject({ confirmation: "WRITE SDK PARAMETER" });
    expect(calls[2].body).toMatchObject({
      confirmation: "APPLY CAMERA CALIBRATION",
      allowExternal: true,
    });
    expect(calls[3].body).toMatchObject({
      confirmation: "APPLY CAMERA ROI",
      allowExternal: true,
    });
    expect(calls[4].body.dryRun).toBe(true);
    expect(calls[4].body.confirmation).toBeUndefined();
    expect(calls[4].body.operationId).toBeUndefined();
    expect(calls[5].body).toMatchObject({
      dryRun: false,
      confirmation: "APPLY CAMERA CALIBRATION SET",
      saveToDevice: true,
      deviceConfirmation: "PERSIST CAMERA PARAMETERS",
      operationId: "apply-operation-1",
    });
    expect(calls[6].body).toEqual({
      rollbackToken: "rollback-token-1",
      operationId: "rollback-operation-1",
      applyOperationId: "apply-operation-1",
      stopStreams: true,
      confirmation: "ROLLBACK CAMERA CALIBRATION",
    });
    expect(fetchMock.mock.calls[8][0]).toBe(
      "http://127.0.0.1:4873/api/calibration/operations/detail?id=apply-operation-1",
    );
    expect(calls[8].body).toMatchObject({
      connectFirst: false,
      saveToDevice: false,
      confirmation: "APPLY LINE CONTINUOUS PRESET",
    });
    expect(calls[9].body).toMatchObject({
      saveToDevice: true,
      deviceConfirmation: "PERSIST CAMERA PARAMETERS",
      allowExternal: true,
    });
    expect(calls[10]).toMatchObject({
      url: "http://127.0.0.1:4873/api/param/save-file",
      body: { ip: "192.168.101.100", path: "param-backup/cam1.nccfg" },
    });
    expect(calls[11].body).toMatchObject({
      deviceConfirmation: "PERSIST CAMERA PARAMETERS",
    });
    expect(calls[12].body).toMatchObject({
      saveToDevice: true,
      deviceConfirmation: "PERSIST CAMERA PARAMETERS",
    });
  });

  it("binds a recovery rollback to its unresolved apply parent and preserves structured 423 fence evidence", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, complete: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 423,
        error: "calibration_reconciliation_required",
        unresolvedOperations: [{
          operationId: "apply-operation-pending",
          kind: "apply",
          status: "needs-reconciliation",
        }],
      }), {
        status: 423,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await rollbackCaptureCalibrationSet({
      rollbackToken: " rollback-token-pending ",
      operationId: " rollback-operation-recovery ",
      applyOperationId: " apply-operation-pending ",
      parentOperationId: " apply-operation-pending ",
      confirmation: CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      rollbackToken: "rollback-token-pending",
      operationId: "rollback-operation-recovery",
      applyOperationId: "apply-operation-pending",
      parentOperationId: "apply-operation-pending",
      stopStreams: true,
      confirmation: CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION,
    });

    const blocked = await loadCaptureCalibration({
      ip: "192.168.101.100",
      path: "D:/cal/cam1.xml",
      confirmation: CAMERA_CALIBRATION_CONFIRMATION,
    }).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(CaptureAdminApiError);
    expect(blocked).toMatchObject({
      status: 423,
      payload: {
        code: 423,
        error: "calibration_reconciliation_required",
        unresolvedOperations: [{ operationId: "apply-operation-pending" }],
      },
    });
  });

  it("requires caller-supplied calibration confirmations and unique expected serials", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadCaptureCalibration({
      ip: "192.168.101.100",
      path: "D:/cal/cam1.xml",
      confirmation: "",
    })).rejects.toThrow(CAMERA_CALIBRATION_CONFIRMATION);
    await expect(loadCaptureRoi({
      ip: "192.168.101.100",
      path: "D:/cal/cam1-roi.xml",
      confirmation: "APPLY ROI",
    })).rejects.toThrow(CAMERA_ROI_CONFIRMATION);
    await expect(rollbackCaptureCalibrationSet({
      rollbackToken: "rollback-token-1",
      operationId: "rollback-operation-1",
      applyOperationId: "apply-operation-1",
      confirmation: "ROLLBACK CALIBRATION",
    })).rejects.toThrow(CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION);
    await expect(rollbackCaptureCalibrationSet({
      rollbackToken: "rollback-token-1",
      operationId: "",
      applyOperationId: "apply-operation-1",
      confirmation: CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION,
    })).rejects.toThrow("operationId");
    await expect(rollbackCaptureCalibrationSet({
      rollbackToken: "rollback-token-1",
      operationId: "rollback-operation-1",
      applyOperationId: "",
      confirmation: CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION,
    })).rejects.toThrow("applyOperationId");
    await expect(rollbackCaptureCalibrationSet({
      rollbackToken: "rollback-token-1",
      operationId: "rollback-operation-1",
      applyOperationId: "apply-operation-1",
      parentOperationId: "   ",
      confirmation: CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION,
    })).rejects.toThrow("parentOperationId");

    const mappings = Array.from({ length: 8 }, (_, index) => ({
      ip: `192.168.${101 + index}.100`,
      path: `D:/cal/cam${index + 1}.xml`,
      expectedSn: index === 7 ? " sn-1 " : `SN-${index + 1}`,
      rollbackPath: `D:/cal/known-good-cam${index + 1}.xml`,
    }));
    await expect(applyCaptureCalibrationSet({
      name: "current-6-soft-trigger",
      cameraCalibrations: mappings,
      dryRun: true,
    })).rejects.toThrow("期望 SN 必须逐相机唯一");
    const duplicatePaths = Array.from({ length: 8 }, (_, index) => ({
      ip: `192.168.${101 + index}.100`,
      path: index === 7 ? "d:\\CAL\\cam1.xml" : `D:/cal/cam${index + 1}.xml`,
      expectedSn: `UNIQUE-SN-${index + 1}`,
      rollbackPath: `D:/cal/known-good-cam${index + 1}.xml`,
    }));
    await expect(applyCaptureCalibrationSet({
      name: "current-6-soft-trigger",
      cameraCalibrations: duplicatePaths,
      dryRun: true,
    })).rejects.toThrow("独立 SDK 标定文件");
    await expect(applyCaptureCalibrationSet({
      name: "current-6-soft-trigger",
      cameraCalibrations: duplicatePaths.map((item, index) => ({
        ...item,
        path: `D:/cal/unique-cam${index + 1}.xml`,
        rollbackPath: index === 0 ? "" : item.rollbackPath,
      })),
      dryRun: true,
    })).rejects.toThrow("跨重启恢复的回滚文件");
    await expect(applyCaptureCalibrationSet({
      name: "current-6-soft-trigger",
      cameraCalibrations: mappings.map((item, index) => ({
        ...item,
        expectedSn: `UNIQUE-SN-${index + 1}`,
      })),
      dryRun: false,
      confirmation: "APPLY CAMERA CALIBRATION SET",
    })).rejects.toThrow("operationId");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back cleanly when local path dialogs and preview saving run outside Tauri", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    Reflect.deleteProperty(window, "__TAURI__");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(chooseCaptureLocalFile("选择 JSON", ["json"])).resolves.toBeNull();
    await expect(chooseCaptureLocalDirectory("选择目录")).resolves.toBeNull();
    await expect(readCaptureLocalTextFile("D:/fit_report.json")).resolves.toBeNull();
    await expect(saveCapturePreviewFromUrl("http://127.0.0.1/preview.png")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
