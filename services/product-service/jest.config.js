/**
 * Jest Configuration for product-service
 */
module.exports = {
  // Test environment
  testEnvironment: 'node',

  // Root directories for test discovery
  roots: ['<rootDir>/__tests__'],

  // Test file patterns
  testMatch: [
    '**/__tests__/**/*.test.js'
  ],

  // Setup file to run after Jest is initialized
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],

  // Module file extensions
  moduleFileExtensions: ['js', 'json'],

  // Coverage configuration
  collectCoverageFrom: [
    'index.js',
    '!**/node_modules/**',
    '!**/vendor/**'
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'html'],

  // Coverage thresholds
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },

  // Verbose output
  verbose: true,

  // Clear mocks between tests
  clearMocks: true,

  // Restore mocks after each test
  restoreMocks: false,

  // Maximum workers
  maxWorkers: '50%',

  // Test timeout (10 seconds)
  testTimeout: 10000,

  // Force exit after all tests complete
  forceExit: true,

  // Detect open handles
  detectOpenHandles: true,

  // Module name mapper for shared lib
  moduleNameMapper: {
    '^../../shared/lib/(.*)$': '<rootDir>/../../shared/lib/$1'
  },

  // Transform ignore patterns for node_modules
  transformIgnorePatterns: [
    '/node_modules/(?!(@elastic/elasticsearch)/)'
  ],

  // Reporter configuration (jest-junit added for CI, install it as devDependency)
  reporters: [
    'default'
  ]
};
