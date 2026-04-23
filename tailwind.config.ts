import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#f5f7ff', 500: '#5b6bff', 600: '#4955e8', 700: '#3b46c2' },
        // Semantic aliases (Franck 2026-04-23 22:46). Previously the
        // app mixed raw tailwind palettes (red-500 vs red-600 vs
        // red-700) for the same semantic intent. These aliases
        // give UI primitives a single source of truth so buttons,
        // chips and toasts never drift again. `subtle` (bg), `solid`
        // (border / primary fill), `strong` (text on light bg).
        danger: {
          subtle: '#fef2f2', // red-50
          solid: '#dc2626',  // red-600
          strong: '#b91c1c', // red-700
        },
        success: {
          subtle: '#f0fdf4', // green-50
          solid: '#16a34a',  // green-600
          strong: '#15803d', // green-700
        },
        warning: {
          subtle: '#fffbeb', // amber-50
          solid: '#d97706',  // amber-600
          strong: '#b45309', // amber-700
        },
      },
    },
  },
  plugins: [],
};
export default config;
