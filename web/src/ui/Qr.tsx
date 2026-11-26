import qrcode from 'qrcode-generator';

export function Qr({ text, size = 160, label }: { text: string; size?: number; label?: string }) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 4},${r + 4}h1v1h-1z`;
  return (
    <svg viewBox={`0 0 ${n + 8} ${n + 8}`} width={size} height={size} role="img" aria-label={label ?? `QR code for ${text}`} style={{ background: '#fff', borderRadius: 8, display: 'block' }}>
      <path d={d} fill="#0A1510" shapeRendering="crispEdges" />
    </svg>
  );
}

let lanBase: string | null = null;
/** Set from GET /system/network so QR codes opened on a laptop at localhost still work on phones on the same Wi-Fi. */
export function setLanBase(b: string | null) { lanBase = b; }
export function appBase(): string {
  const env = import.meta.env.VITE_PUBLIC_BASE_URL as string | undefined;
  if (env) return env.replace(/\/$/, '');
  const local = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  return local && lanBase ? lanBase : location.origin;
}
/** Link a QR opens: the public page of this deployment (no login). */
export function packLink(name: string) {
  return `${appBase()}/#${name}`;
}
