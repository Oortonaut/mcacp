#!/usr/bin/env node
/**
 * Validate server.json against the MCP registry schema.
 * Uses ajv (already a transitive dependency via @modelcontextprotocol/sdk).
 */
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverJsonPath = resolve(__dirname, '..', 'server.json');

const serverJson = JSON.parse(readFileSync(serverJsonPath, 'utf-8'));
const schemaUrl = serverJson.$schema;
if (!schemaUrl) {
  console.error('server.json missing $schema field');
  process.exit(1);
}

console.log(`Fetching schema: ${schemaUrl}`);
const res = await fetch(schemaUrl);
if (!res.ok) {
  console.error(`Failed to fetch schema: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const schema = await res.json();

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);
const valid = validate(serverJson);

if (valid) {
  console.log('server.json is valid.');
} else {
  console.error('server.json validation errors:');
  for (const err of validate.errors) {
    console.error(`  ${err.instancePath || '/'}: ${err.message}`);
  }
  process.exit(1);
}
