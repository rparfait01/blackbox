import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

// Design tokens from PWA_INTERFACE_SPEC §2. The BLACK BOX palette (instrument
// greys + one semantic color) is mapped to shadcn's CSS-variable system in
// src/index.css; the explicit `bb` / `status` / `med` tokens below are the
// shared design language referenced by both the facade and the dashboard.
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // BLACK BOX instrument palette (explicit tokens)
        bb: {
          bg: '#000000',
          surface: '#0F0F0F',
          elevated: '#1A1A1A',
          'border-subtle': '#222222',
          'border-defined': '#333333',
          text: '#E8E8E8',
          'text-secondary': '#888888',
          'text-tertiary': '#555555',
        },
        // The single semantic status colors (only one visible at a time)
        status: {
          armed: '#E89A00',
          active: '#FF3B30',
          ack: '#34C759',
        },
        // Stillpoint meditation facade palette
        med: {
          bg1: '#1a1f3a',
          bg2: '#2d1f4a',
          bg3: '#1f2d4a',
          text: '#F4EDE0',
          accent: '#D4A373',
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        display: ['"IBM Plex Sans Condensed"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', '"SF Mono"', '"Cascadia Mono"', 'monospace'],
        serif: ['"Cormorant Garamond"', 'Georgia', 'serif'],
      },
      fontSize: {
        'display-xl': ['32px', { lineHeight: '36px', letterSpacing: '-0.02em' }],
        'display-l': ['24px', { lineHeight: '28px', letterSpacing: '-0.01em' }],
        'body-l': ['17px', { lineHeight: '24px' }],
        'body-m': ['15px', { lineHeight: '22px' }],
        caption: ['13px', { lineHeight: '18px' }],
        micro: ['11px', { lineHeight: '14px', letterSpacing: '0.06em' }],
      },
      spacing: {
        xs: '4px',
        sm: '8px',
        md: '16px',
        lg: '24px',
        xl: '32px',
        '2xl': '48px',
        '3xl': '64px',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 1px)',
        sm: 'calc(var(--radius) - 2px)',
      },
      keyframes: {
        breathe: {
          '0%, 100%': { transform: 'scale(0.85)', opacity: '0.6' },
          '50%': { transform: 'scale(1.05)', opacity: '1' },
        },
        'breath-label': {
          '0%, 100%': { opacity: '0.3' },
          '25%': { opacity: '1' },
          '50%': { opacity: '0.5' },
          '75%': { opacity: '1' },
        },
        'hue-drift': {
          '0%, 100%': { filter: 'hue-rotate(0deg)' },
          '50%': { filter: 'hue-rotate(15deg)' },
        },
        'bb-pulse': {
          '0%, 100%': { opacity: '0.5', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.02)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        breathe: 'breathe 10s ease-in-out infinite',
        'breath-label': 'breath-label 10s ease-in-out infinite',
        'hue-drift': 'hue-drift 30s ease-in-out infinite',
        'bb-pulse': 'bb-pulse 3s ease-in-out infinite',
        'fade-in': 'fade-in 600ms ease both',
      },
    },
  },
  plugins: [animate],
} satisfies Config;
