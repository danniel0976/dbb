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
        // DBB design system (TCGPlayer-inspired, dark theme)
        'dbb-primary': '#0f172a',      // slate-900 — page background
        'dbb-secondary': '#1e293b',     // slate-800 — cards/surfaces
        'dbb-tertiary': '#334155',      // slate-700 — borders/hover
        'dbb-accent': '#0835DB',        // brand blue — CTAs, links, active
        'dbb-accent-hov': '#1944E8',    // brand blue hover
        'dbb-mint': '#3AC692',          // mint green — positive accents
        'dbb-mint-hov': '#2DA27C',      // mint green hover
        'dbb-price': '#05772D',         // price green
        'dbb-pink': '#E02179',          // NEW tag pink
        'dbb-gold': '#f4d03f',
        'dbb-silver': '#bdc3c7',
        'dbb-bronze': '#cd7f32',
        
        // Rarity colors
        'rarity-common': '#8c8c8c',
        'rarity-uncommon': '#c0c0c0',
        'rarity-rare': '#f4d03f',
        'rarity-mythic': '#e94560',
        
        // Color pie
        'white': '#f5f5dc',
        'blue': '#4a90e2',
        'black': '#2c2c2c',
        'red': '#e74c3c',
        'green': '#27ae60',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Barlow Condensed', 'Inter', 'sans-serif'],
      },
      borderRadius: {
        'dbb': '8px',
      },
      boxShadow: {
        'card': '0 1px 2px rgba(0,0,0,0.3)',
        'card-hover': '0 12px 32px 2px rgba(0,0,0,0.12), 0 4px 8px rgba(0,0,0,0.08)',
      },
      transitionProperty: {
        'card': 'box-shadow',
      },
    },
  },
  plugins: [],
}