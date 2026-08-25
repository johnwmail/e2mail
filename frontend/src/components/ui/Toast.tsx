import React from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useToastStore } from '../../stores/useToastStore';

export const Toast: React.FC = () => {
  const { message, type, clear } = useToastStore();
  if (!message) return null;

  const styles =
    type === 'error'
      ? 'bg-red-600 text-white'
      : type === 'success'
        ? 'bg-emerald-600 text-white'
        : 'bg-slate-800 text-white';
  const Icon = type === 'error' ? AlertCircle : type === 'success' ? CheckCircle2 : Info;

  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[90] w-[calc(100%-2rem)] max-w-sm animate-in fade-in slide-in-from-bottom-2 duration-200 pointer-events-none">
      <div className={`flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg ${styles}`}>
        <Icon className="w-4 h-4 shrink-0" />
        <span className="text-xs font-medium flex-1 leading-snug">{message}</span>
        <button onClick={clear} className="p-0.5 opacity-70 hover:opacity-100 transition pointer-events-auto">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

export default Toast;
