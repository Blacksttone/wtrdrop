import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  define: {
    // Phone push needs Firebase config inside the APK; without it the plugin would crash the app.
    __PUSH_ENABLED__: JSON.stringify(existsSync(fileURLToPath(new URL("./android/app/google-services.json", import.meta.url)))),
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    // jsPDF is loaded on demand only when a bill/report PDF is downloaded.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/jspdf") || id.includes("html2canvas")) return "pdf";
          if (id.includes("node_modules/@supabase")) return "supabase";
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "supabase/functions/**/*.test.ts"],
  },
} as Parameters<typeof defineConfig>[0]);
