import { CheckCircle2, Info } from 'lucide-react';

export function Toast({ message, tone = 'info', onClear }: { message: string | null; tone?: 'info' | 'success'; onClear: () => void }) {
  if (!message) {
    return null;
  }
  const Icon = tone === 'success' ? CheckCircle2 : Info;
  return (
    <button className={`toast toast-${tone}`} type="button" onClick={onClear} title="关闭提示">
      <Icon size={16} />
      <span>{message}</span>
    </button>
  );
}
