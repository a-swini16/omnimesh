import { describe, it, expect } from 'vitest';
import {
  validateOmniMeshConfig,
  parseOmniMeshConfigYaml,
  generateDefaultConfig,
  ConfigValidationError,
} from '../src/index.js';

describe('OmniMesh Core Config Engine', () => {
  it('generates valid default no-card config', () => {
    const config = generateDefaultConfig('no-card');
    expect(config.profile).toBe('no-card');
    expect(config.router.timeoutMs).toBe(2500);
    expect(config.router.maxAttempts).toBe(3);
    expect(config.pools['/api']).toBeDefined();
    expect(config.database.primary).toBe('neon');
    expect(config.storage.provider).toBe('supabase');
  });

  it('generates valid default with-card config including Oracle', () => {
    const config = generateDefaultConfig('with-card');
    expect(config.profile).toBe('with-card');
    expect(config.database.primary).toBe('oracle');
    expect(config.storage.provider).toBe('r2');
  });

  it('parses valid YAML configuration', () => {
    const yaml = `
profile: no-card
domain: custom.domain.io
router:
  timeoutMs: 3000
  maxAttempts: 4
  totalBudgetMs: 8000
pools:
  /api:
    - https://api1.koyeb.app
    - https://api2.onrender.com
database:
  mode: managed
  primary: supabase
`;
    const config = parseOmniMeshConfigYaml(yaml);
    expect(config.domain).toBe('custom.domain.io');
    expect(config.router.timeoutMs).toBe(3000);
    expect(config.router.maxAttempts).toBe(4);
    expect(config.pools['/api']).toHaveLength(2);
  });

  it('rejects short gateway secrets with descriptive validation error', () => {
    expect(() => {
      validateOmniMeshConfig({
        gatewaySecret: 'too-short',
      });
    }).toThrow(ConfigValidationError);
  });

  describe('[M-6] rejects configs that would misroute traffic', () => {
    const bad: Record<string, unknown> = {
      'no pools at all': { pools: {} },
      'an empty pool': { pools: { '/api': [] } },
      'a prefix without a leading slash': { pools: { api: ['https://a.example.com'] } },
      'the same prefix twice (/api and /api/)': { pools: { '/api': ['https://a.example.com'], '/api/': ['https://b.example.com'] } },
      'the same URL twice in one pool': { pools: { '/api': ['https://a.example.com', 'https://a.example.com/'] } },
      'a defaultPool that does not exist': { defaultPool: '/web', pools: { '/api': ['https://a.example.com'] } },
    };
    for (const [name, input] of Object.entries(bad)) {
      it(`rejects ${name}`, () => {
        expect(() => validateOmniMeshConfig(input)).toThrow(ConfigValidationError);
      });
    }

    it('reports duplicate YAML keys as a clear config error, not a stack trace', () => {
      const yaml = 'pools:\n  /api:\n    - https://a.example.com\n  /api:\n    - https://b.example.com\n';
      expect(() => parseOmniMeshConfigYaml(yaml)).toThrow(/unique|duplicate/i);
    });
  });
});
