import { useEffect, useRef, useState } from 'react';
import {
  fetchAppResourceUsage,
  type AppResourceUsage,
} from '../lib/app-resource-usage';

export interface AppResourceUsageState {
  usage: AppResourceUsage | null;
  loading: boolean;
  stale: boolean;
}

type ResourceUsageLoader = (signal?: AbortSignal) => Promise<AppResourceUsage>;

const RESOURCE_SAMPLE_INTERVAL_MS = 5_000;

export function useAppResourceUsage(
  loader: ResourceUsageLoader = fetchAppResourceUsage,
): AppResourceUsageState {
  const [state, setState] = useState<AppResourceUsageState>({
    usage: null,
    loading: false,
    stale: false,
  });
  const inFlightRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    let activeController: AbortController | null = null;

    const sample = async () => {
      if (document.hidden || inFlightRef.current) return;
      inFlightRef.current = true;
      activeController = new AbortController();
      setState((current) => ({ ...current, loading: true }));
      try {
        const usage = await loader(activeController.signal);
        if (mounted) {
          setState({ usage, loading: false, stale: false });
        }
      } catch (error) {
        if (mounted && !(error instanceof DOMException && error.name === 'AbortError')) {
          setState((current) => ({ ...current, loading: false, stale: true }));
        }
      } finally {
        inFlightRef.current = false;
        activeController = null;
      }
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void sample();
      }
    };

    void sample();
    const interval = window.setInterval(() => {
      void sample();
    }, RESOURCE_SAMPLE_INTERVAL_MS);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      mounted = false;
      activeController?.abort();
      inFlightRef.current = false;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loader]);

  return state;
}
