import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        gold: "#d4af37",
      },
    },
  },
  plugins: [],
} satisfies Config;
