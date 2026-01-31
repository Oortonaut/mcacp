#!/usr/bin/env node
import { createServer } from './server/index.js';

async function main() {
  const server = await createServer();
  await server.start();
}

main().catch((err) => {
  console.error('MCACP fatal error:', err);
  process.exit(1);
});
