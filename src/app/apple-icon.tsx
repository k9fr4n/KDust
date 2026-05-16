import { ImageResponse } from 'next/og';

// Apple touch icon — rendered as PNG by Next at build/request time.
// Design: KDust single "K" mark in amber on a slate-900 rounded square,
// optimized to stay legible down to 16x16 favicon sizes.

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
          fontSize: 160,
          fontWeight: 900,
          lineHeight: 1,
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        }}
      >
        K
      </div>
    ),
    { ...size },
  );
}
