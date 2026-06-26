import { swaggerSpec } from '../src/swagger';

describe('swagger spec', () => {
  test('has OpenAPI version and basic info', () => {
    expect(swaggerSpec).toBeDefined();
    expect(swaggerSpec.openapi).toBe('3.0.0');
    expect(swaggerSpec.info).toBeDefined();
    expect(swaggerSpec.info.title).toMatch(/SYNCRO/i);
    expect(swaggerSpec.info.version).toBeDefined();
  });
});
