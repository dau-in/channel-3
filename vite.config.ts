import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      // Precache everything, ROMs included: the emulator is fully
      // client-side, so offline it behaves like a real console. Only
      // netplay (WebRTC broker) needs the network.
      workbox: {
        globPatterns: ["**/*.{js,css,html,woff,woff2,png,json,nes}"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      manifest: {
        name: "Channel 3 — NES emulator",
        short_name: "Channel 3",
        description:
          "NES emulator with CRT shader, P2P netplay, rewind and a built-in homebrew library.",
        display: "standalone",
        orientation: "landscape",
        // Ghost Slate's background, so the splash and the icon are the same
        // slate rather than the old burgundy.
        background_color: "#14161c",
        theme_color: "#14161c",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            // Separate art: Android crops the outer 20% of a maskable icon,
            // which would take the antenna tips off the full-bleed version.
            src: "icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
});
