import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required for camera access on phones; host: true exposes it on the LAN.
export default defineConfig({
  plugins: [basicSsl()],
  server: { host: true },
});
