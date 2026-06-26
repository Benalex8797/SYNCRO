module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.ts'],
    verbose: true,
    forceExit: true,
    clearMocks: false,
    resetMocks: false,
    restoreMocks: false,
    setupFiles: ['<rootDir>/tests/setup.ts'],
    moduleNameMapper: {
        '^@syncro/shared$': '<rootDir>/../shared/src',
        '^@syncro/shared/(.*)$': '<rootDir>/../shared/src/$1',
    },
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {
            diagnostics: false,
            tsconfig: {
                target: 'ES2022',
                module: 'commonjs',
                esModuleInterop: true,
                skipLibCheck: true,
            },
        }],
        '^.+\\.js$': ['ts-jest', { diagnostics: false }],
    },
    transformIgnorePatterns: [
        '/node_modules/(?!(@stellar/stellar-sdk|uuid))',
    ],
    coverageThreshold: {
        global: {
            branches: 80,
            functions: 80,
            lines: 80,
            statements: 80,
        },
    },
};
