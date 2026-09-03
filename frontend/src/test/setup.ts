import '@testing-library/jest-dom';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { setLocale } from '../i18n';

setLocale('en');

afterEach(() => {
  cleanup();
  localStorage.clear();
  setLocale('en');
  vi.restoreAllMocks();
});

// jsdom 未有 matchMedia 實作，部分組件會用到
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
