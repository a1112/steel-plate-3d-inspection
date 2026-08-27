import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { vi } from 'vitest';

const storageEntries = new Map<string, string>();
const testLocalStorage: Storage = {
  get length() {
    return storageEntries.size;
  },
  clear() {
    storageEntries.clear();
  },
  getItem(key) {
    return storageEntries.get(String(key)) ?? null;
  },
  key(index) {
    return Array.from(storageEntries.keys())[index] ?? null;
  },
  removeItem(key) {
    storageEntries.delete(String(key));
  },
  setItem(key, value) {
    storageEntries.set(String(key), String(value));
  },
};

// Node 25+ exposes an experimental global localStorage that is undefined unless
// --localstorage-file is supplied. Vitest otherwise preserves that property
// instead of installing jsdom's storage, so provide a deterministic per-worker
// implementation for browser-facing tests on every supported Node version.
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  enumerable: true,
  value: testLocalStorage,
});

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _children, ...props }: { children?: unknown }) => createElement('div', { ...props, 'data-testid': 'mock-r3f-canvas' }),
  useFrame: () => undefined,
  useThree: () => ({
    camera: {
      position: { set: vi.fn() },
      lookAt: vi.fn(),
      updateProjectionMatrix: vi.fn(),
    },
    size: { width: 800, height: 400 },
  }),
}));
