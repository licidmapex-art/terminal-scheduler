export function formatRelativeTime(ts: number): string {
  if (!ts) return "No run yet";
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return "Just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} h ago`;
  const d = Math.floor(hr / 24);
  return `${d} d ago`;
}
