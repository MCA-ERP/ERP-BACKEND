/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          sky: '#0EA5E9',
          'sky-light': '#0EA5E915',
          'sky-hover': '#0284C7',
          'sky-dark': '#0369A1',
          blue: '#3B82F6',
          'blue-hover': '#2563EB',
          'blue-light': '#3B82F615',
          red: '#E53A35',
          'red-hover': '#c82824',
          'red-light': '#E53A3515',
          cyan: '#06B6D4',
          'cyan-light': '#06B6D415',
        }
      },
      boxShadow: {
        'glass': '0 10px 30px -5px rgba(14, 165, 233, 0.08), 0 0 15px -3px rgba(59, 130, 246, 0.05)',
        'glass-hover': '0 20px 40px -10px rgba(14, 165, 233, 0.2), 0 0 20px -3px rgba(59, 130, 246, 0.1)',
        'glow-sky': '0 0 20px rgba(14, 165, 233, 0.35)',
        'glow-blue': '0 0 20px rgba(59, 130, 246, 0.35)',
      }
    },
  },
  plugins: [],
};
