/**
 * Jest Configuration — order-service
 */

module.exports = {
  testEnvironment: 'node',

  // Test file discovery
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/__tests__/**/*.test.js'],

  // Setup files
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],

  // Module paths for shared imports
  moduleNameMapper: {
    '^../../shared/lib/(.*)$': '<rootDir>/../../shared/lib/$1',
    '^../sagas/(.*)$': '<rootDir>/sagas/$1',
  },

  // Coverage settings
  collectCoverageFrom: [
    'index.js',
    'sagas/**/*.js',
    '!**/node_modules/**',
    '!**/vendor/**',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'html'],

  // reporters
  verbose: true,

  // Timeout
  testTimeout: 10000,

  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,

  // Force exit after all tests complete
  forceExit: true,
  detectOpenHandles: true,

  // Don't look for tests in node_modules
  testPathIgnorePatterns: [
    '/node_modules/',
    '/.store/',
  ],

  // Transform
  transform: {},
};
