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

// The older inner pages use sky / blue / indigo as their "primary" colour
// (links, primary buttons, selected states). Those are REMAPPED to a
// champagne-ink scale so they pick up the brand without per-page edits.
// 600+ are dark enough for white button text (600: 6.6:1) and for link
// text on white / ivory. Red, amber and green are left alone on purpose:
// they carry meaning (error, warning, success).
const champagneInk = {
  50: "#FAF6EE",
  100: "#F3EAD8",
  200: "#E8D6B4",
  300: "#D4B07A",
  400: "#B8925A",
  500: "#96713C",
  600: "#7A5524",
  700: "#5C3F19",
  800: "#43300F",
  900: "#2E200A",
  950: "#1E1505",
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
        sky: champagneInk,
        blue: champagneInk,
        indigo: champagneInk,
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
