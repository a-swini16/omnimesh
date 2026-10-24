#!/usr/bin/env node
// The packages ship TypeScript sources with no build step, so load them through tsx
import { register } from 'tsx/esm/api';

register();
await import('../src/index.ts');
