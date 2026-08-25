/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  // Point every test file at the dedicated test database before any module loads.
  setupFiles: ['<rootDir>/tests/env.ts'],
  // Creates/migrates/truncates that database once, before the suite runs.
  globalSetup: '<rootDir>/tests/globalSetup.ts',
  // Closes the connection pool so Jest exits cleanly.
  setupFilesAfterEnv: ['<rootDir>/tests/teardown.ts'],
  testTimeout: 30000,
  clearMocks: true,
};
