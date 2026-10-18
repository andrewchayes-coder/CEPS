import { linkify } from '@/lib/messaging';

export function MessageBody({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-sm">
      {linkify(text).map((s, i) =>
        s.type === 'link' ? (
          <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" className="text-primary underline break-all">{s.value}</a>
        ) : (
          <span key={i}>{s.value}</span>
        ),
      )}
    </p>
  );
}
