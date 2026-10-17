/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          50: '#f4f6f9', 100: '#e6eaf0', 200: '#c9d1dc', 300: '#a3afbf', 400: '#7a889c', 500: '#5b687b',
          600: '#434e5f', 700: '#323b49', 800: '#232a35', 850: '#1b212a', 900: '#151a21', 950: '#0e1217',
        },
        accent: { 300: '#7dd3fc', 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7' },
      },
      fontFamily: {
        sans: ['Inter', '"Segoe UI"', 'system-ui', '-apple-system', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Consolas', '"Cascadia Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
