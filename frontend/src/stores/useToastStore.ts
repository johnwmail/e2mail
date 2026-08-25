import { create } from 'zustand';

type ToastType = 'error' | 'success' | 'info';

interface ToastState {
  message: string | null;
  type: ToastType;
  show: (message: string, type?: ToastType) => void;
  clear: () => void;
}

export const useToastStore = create<ToastState>((set) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    message: null,
    type: 'info',
    show: (message, type = 'info') => {
      if (timer) clearTimeout(timer);
      set({ message, type });
      timer = setTimeout(() => set({ message: null }), 4000);
    },
    clear: () => {
      if (timer) clearTimeout(timer);
      set({ message: null });
    },
  };
});

export function toast(message: string, type: ToastType = 'error') {
  useToastStore.getState().show(message, type);
}
