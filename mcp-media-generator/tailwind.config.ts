import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Cairo", "Tajawal", "Segoe UI", "system-ui", "sans-serif"],
      },
      colors: {
        ink: {
          950: "#080c14",
          900: "#0b1220",
          850: "#0f172a",
          800: "#141d31",
          700: "#1e293b",
        },
        brand: {
          400: "#38d6f5",
          500: "#06b6d4",
          600: "#0891b2",
        },
        violet: {
          400: "#a78bfa",
          500: "#8b5cf6",
        },
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(56,214,245,0.15), 0 18px 50px -20px rgba(6,182,212,0.45)",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
      },
      animation: {
        shimmer: "shimmer 2.4s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
