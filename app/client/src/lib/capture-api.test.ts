import { describe, expect, it } from "vitest";
import {
  calculateSystemNetworkRates,
  type SystemNetworkSnapshot,
} from "./capture-api";

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

    const rates = calculateSystemNetworkRates(current, previous);

    expect(rates.interfaces).toHaveLength(1);
    expect(rates.interfaces[0].downloadMbps).toBe(200);
    expect(rates.interfaces[0].uploadMbps).toBe(100);
    expect(rates.interfaces[0].bandwidthMbps).toBe(1000);
    expect(rates.interfaces[0].online).toBe(true);
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
