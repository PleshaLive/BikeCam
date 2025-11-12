import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/webrtc/diag/",
  build: {
    outDir: "public/webrtc/diag",
    emptyOutDir: true,
  },
});
