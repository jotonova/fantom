import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        fantom: {
          steel: '#0D1B2A',
          'steel-lighter': '#162232',
          'steel-border': '#1E3045',
          blue: '#1B4F8C',
          'blue-bright': '#3B82F6',
          gold: '#B8862A',
          'gold-bright': '#F5C842',
          text: '#E8EDF2',
          'text-muted': '#7A8FA6',
        },
      },
      borderRadius: {
        fantom: '10px',
      },
      backgroundImage: {
        'fantom-brand-gradient': 'linear-gradient(135deg, #1B4F8C 0%, #0D1B2A 100%)',
      },
      fontFamily: {
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}

export default config
