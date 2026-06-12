/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // MTG-inspired color palette
        'dbb-primary': '#1a1a2e',
        'dbb-secondary': '#16213e',
        'dbb-accent': '#e94560',
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
        display: ['Playfair Display', 'serif'],
      },
    },
  },
  plugins: [],
}
