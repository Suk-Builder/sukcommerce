module.exports = {
  testEnvironment: 'node',
  setupFilesAfterEnv: ['./__tests__/setup.js'],
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['index.js', '!node_modules/**', '!__tests__/**'],
  modulePathIgnorePatterns: ['<rootDir>/node_modules/'],
  testMatch: ['**/__tests__/**/*.test.js'],
  verbose: true,
  clearMocks: true,
  restoreMocks: true,
};
