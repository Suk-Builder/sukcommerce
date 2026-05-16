/**
 * Jest configuration for payment-service
 */
module.exports = {
  // Use jsdom for DOM-related tests (Node for API tests)
  testEnvironment: 'node',

  // Test file patterns
  testMatch: [
    '**/__tests__/**/*.test.js',
  ],

  // Setup files to run before tests
  setupFilesAfterEnv: [
    '<rootDir>/__tests__/setup.js',
  ],

  // Coverage configuration
  collectCoverageFrom: [
    'index.js',
    'strategies/**/*.js',
    '!**/node_modules/**',
    '!**/__tests__/**',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'html'],

  // Module paths for shared lib
  moduleNameMapper: {
    '^../../shared/lib/(.*)$': '<rootDir>/../../shared/lib/$1',
  },

  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,

  // Verbose output
  verbose: true,

  // Fail on console errors/warnings during tests
  errorOnDeprecated: true,

  // Timeout for async operations
  testTimeout: 10000,
};
