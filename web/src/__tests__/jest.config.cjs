// Reuses the repository's installed Jest/ts-jest without adding frontend dependencies.
module.exports = {
  rootDir: '../..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/__tests__/*.test.cjs'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  transform: {
    '^.+\\.tsx?$': ['<rootDir>/functions/node_modules/ts-jest', {
      tsconfig: {
        target: 'ES2022', module: 'CommonJS', moduleResolution: 'node', jsx: 'react-jsx',
        esModuleInterop: true, verbatimModuleSyntax: false, baseUrl: '.',
        paths: { '@/*': ['./src/*'] }, skipLibCheck: true,
      },
      // The frontend build performs full type checking separately from the CJS test runner.
      diagnostics: false,
    }],
  },
};
