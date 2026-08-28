import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ImgHTMLAttributes,
} from 'react';

const RENDITION_PATHS = new Set([
  '/api/capture/file',
  '/api/capture/render',
  '/api/production/file',
]);
const SIZE_STEP = 64;
const MAX_DIMENSION = 4096;

function requestedPixels(cssPixels: number, pixelRatio: number) {
  const physical = Math.max(1, Math.ceil(cssPixels * Math.max(1, pixelRatio)));
  return Math.min(MAX_DIMENSION, Math.ceil(physical / SIZE_STEP) * SIZE_STEP);
}

export function requestedSizeImageUrl(
  source: string,
  cssWidth: number,
  cssHeight: number,
  pixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
) {
  const trimmed = source.trim();
  if (!trimmed || /^(?:data:|blob:)/i.test(trimmed)) return source;
  const pageOrigin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  let url: URL;
  try {
    url = new URL(trimmed, pageOrigin);
  } catch {
    return source;
  }
  if (!RENDITION_PATHS.has(url.pathname)) return source;
  url.searchParams.set('maxWidth', String(requestedPixels(cssWidth, pixelRatio)));
  url.searchParams.set('maxHeight', String(requestedPixels(cssHeight, pixelRatio)));
  if (trimmed.startsWith('/')) {
    return `${url.pathname}${url.search}${url.hash}`;
  }
  return url.toString();
}

type RequestedSizeImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  requestWidth?: number;
  requestHeight?: number;
  disableRequestedSize?: boolean;
};

export function RequestedSizeImage({
  src = '',
  requestWidth = 640,
  requestHeight = 360,
  disableRequestedSize = false,
  ...props
}: RequestedSizeImageProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [slot, setSlot] = useState({ width: requestWidth, height: requestHeight });

  useLayoutEffect(() => {
    const image = imageRef.current;
    if (!image || typeof ResizeObserver !== 'function') return undefined;
    const update = () => {
      const rect = image.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setSlot((current) => {
        const width = Math.max(1, rect.width);
        const height = Math.max(1, rect.height);
        const currentUrl = requestedSizeImageUrl(src, current.width, current.height);
        const nextUrl = requestedSizeImageUrl(src, width, height);
        return currentUrl === nextUrl ? current : { width, height };
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(image);
    return () => observer.disconnect();
  }, [src]);

  const requestedSource = useMemo(
    () => disableRequestedSize ? src : requestedSizeImageUrl(src, slot.width, slot.height),
    [disableRequestedSize, slot.height, slot.width, src],
  );

  return <img {...props} ref={imageRef} src={requestedSource} />;
}
