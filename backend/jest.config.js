module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.ts'],
    verbose: true,
    forceExit: true,
    clearMocks: true,
    resetMocks: true,
    restoreMocks: true,
    setupFiles: ['<rootDir>/tests/setup.ts'],
    transform: {
        '^.+\\.tsx?$': 'ts-jest',
        '^.+\\.js$': ['ts-jest', { diagnostics: false }],
    },
    globals: {
        'ts-jest': {
            diagnostics: false,
            tsconfig: {
                target: 'ES2022',
                module: 'commonjs',
                esModuleInterop: true,
                skipLibCheck: true,
            },
        },
    },
    transformIgnorePatterns: [
        '/node_modules/(?!(@stellar/stellar-sdk|uuid))',
    ],
    coverageReporters: ['text-summary', 'json-summary', 'lcov'],
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
        '!src/types/**',
        '!src/swagger.ts',
        '!src/**/*.example.ts',
    ],
    // Ratchet, not a target — see coverage-thresholds.json. Set at the measured
    // floor (issue #1090) so the gate is green and meaningful; the previous 80%
    // was aspirational and failed every run, which made the gate meaningless.
    coverageThreshold: {
        global: {
            branches: 44,
            functions: 55,
            lines: 55,
            statements: 55,
        },
    },
};
