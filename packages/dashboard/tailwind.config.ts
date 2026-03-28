import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "#0066cc",
          50: "#e6f0ff",
          100: "#b3d1ff",
          200: "#80b3ff",
          300: "#4d94ff",
          400: "#1a75ff",
          500: "#0066cc",
          600: "#0052a3",
          700: "#003d7a",
          800: "#002952",
          900: "#001429",
        },
        admin: {
          DEFAULT: "#d97706",
          50: "#fffbeb",
          100: "#fef3c7",
          200: "#fde68a",
          300: "#fcd34d",
          400: "#fbbf24",
          500: "#f59e0b",
          600: "#d97706",
          700: "#b45309",
          800: "#92400e",
          900: "#78350f",
        },
      },
    },
  },
  plugins: [],
};

export default config;
