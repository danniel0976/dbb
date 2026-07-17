/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // DBB design system v2 — RED accent (Phase 23)
        // Uses RGB CSS variables for auto light/dark switching with opacity support
        'dbb-primary': 'rgb(var(--dbb-bg-rgb) / <alpha-value>)',
        'dbb-secondary': 'rgb(var(--dbb-surface-rgb) / <alpha-value>)',
        'dbb-tertiary': 'rgb(var(--dbb-border-rgb) / <alpha-value>)',
        'dbb-accent': 'rgb(var(--dbb-accent-rgb) / <alpha-value>)',
        'dbb-accent-hov': 'rgb(var(--dbb-accent-hov-rgb) / <alpha-value>)',
        // dbb-mint retired (DBB Glass Mono, Pass 1) — aliased to the single accent
        // so any lingering usages still render sanely until Pass 2 removes them.
        'dbb-mint': 'rgb(var(--dbb-accent-rgb) / <alpha-value>)',
        'dbb-mint-hov': 'rgb(var(--dbb-accent-hov-rgb) / <alpha-value>)',
        'dbb-surface-elevated': 'var(--dbb-surface-elevated)',
        'dbb-price': 'rgb(var(--dbb-price-rgb) / <alpha-value>)',
        'dbb-pink': '#E02179',
        'dbb-gold': '#f4d03f',
        'dbb-silver': '#bdc3c7',
        'dbb-bronze': '#cd7f32',
        
        // Rarity colors
        'rarity-common': '#8c8c8c',
        'rarity-uncommon': '#c0c0c0',
        'rarity-rare': '#f4d03f',
        'rarity-mythic': '#e94560',
        
        // Color pie (MTG)
        'white': '#f5f5dc',
        'blue': '#4a90e2',
        'black': '#2c2c2c',
        'red': '#e74c3c',
        'green': '#27ae60',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        // Barlow Condensed retired (DBB Glass Mono, Pass 1) — Inter used for
        // display/heading text too, paired with tighter tracking (see
        // `tracking-heading` below).
        display: ['Inter', 'system-ui', 'sans-serif'],
      },
      letterSpacing: {
        'heading': '-0.02em',
      },
      fontSize: {
        'dbb-xs': '12px',
        'dbb-sm': '14px',
        'dbb-base': '17px',
        'dbb-lg': '22px',
        'dbb-xl': '28px',
        'dbb-2xl': '34px',
      },
      borderRadius: {
        'dbb': '8px',
        'dbb-sm': 'var(--r-sm)',
        'dbb-md': 'var(--r-md)',
        'dbb-lg': 'var(--r-lg)',
        'dbb-xl': 'var(--r-xl)',
      },
      boxShadow: {
        'card': '0 1px 2px rgba(0,0,0,0.3)',
        'card-hover': '0 12px 32px 2px rgba(0,0,0,0.12), 0 4px 8px rgba(0,0,0,0.08)',
        'dbb-sm': 'var(--shadow-sm)',
        'dbb-md': 'var(--shadow-md)',
      },
      transitionProperty: {
        'card': 'box-shadow',
      },
    },
  },
  plugins: [],
}