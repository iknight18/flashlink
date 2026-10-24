import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * Dev-only sink for receiver diagnostics (see src/diagnostics.ts): prints each entry
 * in the terminal and appends it to logs/session-<time>.jsonl.
 */
function diagnosticsLog(): Plugin {
  return {
    name: 'flashlink-diagnostics',
    apply: 'serve',
    configureServer(server) {
      const dir = join(server.config.root, 'logs');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
      server.middlewares.use('/__flashlink/log', (req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const line = JSON.stringify({ at: new Date().toISOString(), ...JSON.parse(body || '{}') });
          appendFileSync(file, line + '\n');
          server.config.logger.info(`[rx] ${line}`);
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

// HTTPS is required for camera access on phones; host: true exposes it on the LAN.
export default defineConfig({
  plugins: [basicSsl(), diagnosticsLog()],
  server: { host: true },
  // Two pages: the camera receiver (index.html) and the screen-bulb emitter (emitter.html).
  build: {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        emitter: fileURLToPath(new URL('./emitter.html', import.meta.url)),
      },
    },
  },
});
