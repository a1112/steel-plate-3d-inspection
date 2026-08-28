import { captureArtifactBinaryUrl } from '../lib/capture-api';

export type CapturePixel = {
  sourceX: number;
  sourceY: number;
  cropXRatio: number;
  rowRatio: number;
};

type DepthPlane = {
  width: number;
  height: number;
  valueAt: (index: number) => number;
};

const depthPlaneCache = new Map<string, Promise<DepthPlane>>();
const jetCanvasCache = new Map<string, Promise<HTMLCanvasElement>>();

function boundedCacheSet<T>(cache: Map<string, T>, key: string, value: T, maximum: number) {
  cache.set(key, value);
  while (cache.size > maximum) cache.delete(cache.keys().next().value as string);
}

export function captureDepthArtifactRef(artifactRef: string) {
  return artifactRef
    .replace(/([\\/])2d([\\/])/i, '$13d$2')
    .replace(/\.[^./\\]+$/, '.npz');
}

export function mapFramePointerToCapturePixel({
  localX,
  localY,
  displayWidth,
  displayHeight,
  sourceWidth,
  sourceHeight,
  validRoi,
  orientation,
}: {
  localX: number;
  localY: number;
  displayWidth: number;
  displayHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  validRoi: [number, number, number, number] | null;
  orientation: 'horizontal' | 'vertical';
}): CapturePixel {
  const width = Math.max(1, displayWidth);
  const height = Math.max(1, displayHeight);
  const [cropLeft, cropTop, cropRight, cropBottom] = validRoi ?? [0, 0, sourceWidth, sourceHeight];
  const cropWidth = Math.max(1, cropRight - cropLeft);
  const cropHeight = Math.max(1, cropBottom - cropTop);
  const normalizedX = Math.max(0, Math.min(1, localX / width));
  const normalizedY = Math.max(0, Math.min(1, localY / height));
  const cropXRatio = orientation === 'horizontal' ? 1 - normalizedY : normalizedX;
  const rowRatio = orientation === 'horizontal' ? normalizedX : normalizedY;
  return {
    sourceX: Math.max(cropLeft, Math.min(cropRight - 1, Math.round(cropLeft + cropXRatio * (cropWidth - 1)))),
    sourceY: Math.max(cropTop, Math.min(cropBottom - 1, Math.round(cropTop + rowRatio * (cropHeight - 1)))),
    cropXRatio,
    rowRatio,
  };
}

function jetRgbAt(normalized: number) {
  const four = 4 * normalized;
  return [3, 2, 1].map((offset) => Math.round(Math.max(0, Math.min(1, 1.5 - Math.abs(four - offset))) * 255));
}

const jetLookup = Array.from({ length: 513 }, (_, index) => ({
  residualMm: -1 + index / 256,
  rgb: jetRgbAt(index / 512),
}));

export function decodeJetResidualRgb(red: number, green: number, blue: number) {
  if (![red, green, blue].every(Number.isFinite) || Math.max(red, green, blue) < 12) return null;
  let nearest = jetLookup[0];
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of jetLookup) {
    const distance = (candidate.rgb[0] - red) ** 2
      + (candidate.rgb[1] - green) ** 2
      + (candidate.rgb[2] - blue) ** 2;
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest.residualMm;
}

function loadJetCanvas(url: string) {
  const cached = jetCanvasCache.get(url);
  if (cached) return cached;
  const promise = new Promise<HTMLCanvasElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, image.naturalWidth);
      canvas.height = Math.max(1, image.naturalHeight);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        reject(new Error('depth_probe_canvas_unavailable'));
        return;
      }
      context.drawImage(image, 0, 0);
      resolve(canvas);
    };
    image.onerror = () => reject(new Error('depth_probe_jet_unavailable'));
    image.src = url;
  });
  boundedCacheSet(jetCanvasCache, url, promise, 24);
  promise.catch(() => jetCanvasCache.delete(url));
  return promise;
}

export async function sampleJetResidualMm(url: string, cropXRatio: number, rowRatio: number) {
  const canvas = await loadJetCanvas(url);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  const x = Math.max(0, Math.min(canvas.width - 1, Math.round(cropXRatio * (canvas.width - 1))));
  const y = Math.max(0, Math.min(canvas.height - 1, Math.round(rowRatio * (canvas.height - 1))));
  const left = Math.max(0, x - 1);
  const top = Math.max(0, y - 1);
  const width = Math.min(canvas.width - left, 3);
  const height = Math.min(canvas.height - top, 3);
  const pixels = context.getImageData(left, top, width, height).data;
  const values: number[] = [];
  for (let index = 0; index < pixels.length; index += 4) {
    const residual = decodeJetResidualRgb(pixels[index], pixels[index + 1], pixels[index + 2]);
    if (residual !== null) values.push(residual);
  }
  if (!values.length) return null;
  values.sort((leftValue, rightValue) => leftValue - rightValue);
  return values[Math.floor(values.length / 2)];
}

function findEndOfCentralDirectory(view: DataView) {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error('depth_probe_npz_directory_missing');
}

function zip64Values(extra: Uint8Array) {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  for (let offset = 0; offset + 4 <= view.byteLength;) {
    const type = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    if (type === 0x0001) {
      const values: number[] = [];
      for (let cursor = offset + 4; cursor + 8 <= offset + 4 + size; cursor += 8) {
        values.push(Number(view.getBigUint64(cursor, true)));
      }
      return values;
    }
    offset += 4 + size;
  }
  return [];
}

async function firstNpyFromNpz(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const end = findEndOfCentralDirectory(view);
  const entries = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let index = 0; index < entries; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    let compressedSize = view.getUint32(offset + 20, true);
    let uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    let localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const extra = bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    const zip64 = zip64Values(extra);
    let zip64Index = 0;
    if (uncompressedSize === 0xffffffff) uncompressedSize = zip64[zip64Index++] ?? uncompressedSize;
    if (compressedSize === 0xffffffff) compressedSize = zip64[zip64Index++] ?? compressedSize;
    if (localOffset === 0xffffffff) localOffset = zip64[zip64Index] ?? localOffset;
    if (name.toLowerCase().endsWith('.npy')) {
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('depth_probe_npz_entry_invalid');
      const method = view.getUint16(offset + 10, true);
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(start, start + compressedSize);
      if (method === 0) return compressed;
      if (method !== 8 || typeof DecompressionStream === 'undefined') {
        throw new Error('depth_probe_npz_compression_unsupported');
      }
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const decompressed = new Uint8Array(await new Response(stream).arrayBuffer());
      if (uncompressedSize > 0 && decompressed.byteLength !== uncompressedSize) {
        throw new Error('depth_probe_npz_size_mismatch');
      }
      return decompressed;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('depth_probe_npy_missing');
}

function parseNpy(bytes: Uint8Array): DepthPlane {
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 6)) !== '\u0093NUMPY') {
    throw new Error('depth_probe_npy_header_invalid');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[6];
  const headerLength = major <= 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major <= 1 ? 10 : 12;
  const header = new TextDecoder('latin1').decode(bytes.subarray(headerStart, headerStart + headerLength));
  const descriptor = header.match(/['"]descr['"]\s*:\s*['"]([^'"]+)['"]/)?.[1] ?? '';
  const shape = header.match(/['"]shape['"]\s*:\s*\(([^)]+)\)/)?.[1]
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0) ?? [];
  if (/fortran_order['"]?\s*:\s*True/i.test(header) || shape.length < 2) {
    throw new Error('depth_probe_npy_layout_unsupported');
  }
  const height = shape.at(-2) ?? 0;
  const width = shape.at(-1) ?? 0;
  const dataOffset = headerStart + headerLength;
  const dataView = new DataView(bytes.buffer, bytes.byteOffset + dataOffset, bytes.byteLength - dataOffset);
  const littleEndian = !descriptor.startsWith('>');
  const kind = descriptor.at(-2);
  const size = Number(descriptor.at(-1));
  const readers: Record<string, (index: number) => number> = {
    u1: (index) => dataView.getUint8(index),
    i1: (index) => dataView.getInt8(index),
    u2: (index) => dataView.getUint16(index * 2, littleEndian),
    i2: (index) => dataView.getInt16(index * 2, littleEndian),
    u4: (index) => dataView.getUint32(index * 4, littleEndian),
    i4: (index) => dataView.getInt32(index * 4, littleEndian),
    f4: (index) => dataView.getFloat32(index * 4, littleEndian),
    f8: (index) => dataView.getFloat64(index * 8, littleEndian),
  };
  const valueAt = readers[`${kind}${size}`];
  if (!valueAt || width * height * size > dataView.byteLength) throw new Error('depth_probe_npy_dtype_unsupported');
  return { width, height, valueAt };
}

async function loadDepthPlane(artifactRef: string) {
  const depthRef = captureDepthArtifactRef(artifactRef);
  const cached = depthPlaneCache.get(depthRef);
  if (cached) return cached;
  const promise = fetch(captureArtifactBinaryUrl(depthRef), { cache: 'force-cache' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`depth_probe_http_${response.status}`);
      return parseNpy(await firstNpyFromNpz(await response.arrayBuffer()));
    });
  boundedCacheSet(depthPlaneCache, depthRef, promise, 8);
  promise.catch(() => depthPlaneCache.delete(depthRef));
  return promise;
}

export async function readCaptureRawDepthValue(artifactRef: string, sourceX: number, sourceY: number) {
  const plane = await loadDepthPlane(artifactRef);
  const x = Math.max(0, Math.min(plane.width - 1, Math.round(sourceX)));
  const y = Math.max(0, Math.min(plane.height - 1, Math.round(sourceY)));
  const value = plane.valueAt(y * plane.width + x);
  return Number.isFinite(value) && value !== 0 ? value : null;
}
