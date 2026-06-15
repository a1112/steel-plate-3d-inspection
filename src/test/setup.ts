import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { vi } from 'vitest';

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
