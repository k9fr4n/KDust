import { ImageResponse } from 'next/og';

// Apple touch icon — rendered as PNG by Next at build/request time.
// Design: KDust monogram "KD" in amber on a slate-900 rounded square.

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#1e293b',
          color: '#fbbf24',
          fontSize: 96,
          fontWeight: 800,
          letterSpacing: '-4px',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        }}
      >
        KD
      </div>
    ),
    { ...size },
  );
}
