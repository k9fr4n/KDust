import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#f5f7ff', 500: '#5b6bff', 600: '#4955e8', 700: '#3b46c2' },
      },
    },
  },
  plugins: [],
};
export default config;
