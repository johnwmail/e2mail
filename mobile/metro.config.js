const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

// Monorepo setup: Metro must watch the repo root and resolve hoisted deps.
// https://docs.expo.dev/guides/monorepos/
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Hierarchical lookup stays ON: npm workspaces nest a dependency (e.g. reanimated's
// semver@7 under a hoisted semver@6) whenever versions conflict, and those copies
// are only reachable by walking up from the requiring file.

module.exports = config;
