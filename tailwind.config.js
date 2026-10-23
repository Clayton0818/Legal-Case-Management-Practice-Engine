/** @type {import('tailwindcss').Config} */

// Espresso & champagne theme (approved Style B mockups, 2026-10-23).
//
// `slate` is deliberately REMAPPED to warm, espresso-tinted neutrals: every
// existing admin page is written with slate-* utilities, so this one change
// moves the whole staff console onto the warm palette without editing each
// page. Each step keeps roughly the luminance of Tailwind's original slate
// step, so text contrast on white / slate-50 stays at or above the original
// (slate-500 text: 5.3:1 on white, 4.8:1 on slate-50).
const warmSlate = {
  50: "#F7F4EF",
  100: "#F0EBE4",
  200: "#E6DFD5",
  300: "#D3C9BC",
  400: "#A39689",
  500: "#74675C",
  600: "#5C5047",
  700: "#463B33",
  800: "#2E241E",
  900: "#211915",
  950: "#140F0C",
};

export default {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        slate: warmSlate,
        espresso: {
          DEFAULT: "#241B17",
          deep: "#1E1714",
          panel: "#2A201B",
          bubble: "#3A2D26",
        },
        champagne: {
          DEFAULT: "#D4B07A",
          light: "#E8CC9C",
          ink: "#7A5524",
        },
        ivory: {
          DEFAULT: "#F7F4EF",
          bright: "#F7F4EE",
          text: "#EFE8E0",
        },
        taupe: {
          DEFAULT: "#C2B5A8",
          dim: "#B5A89B",
          faint: "#A39689",
        },
      },
      fontFamily: {
        sans: ["Manrope", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
        display: ["\"Instrument Serif\"", "Georgia", "Cambria", "\"Times New Roman\"", "serif"],
      },
      borderRadius: {
        "4xl": "2rem",
      },
    },
  },
  plugins: [],
}
