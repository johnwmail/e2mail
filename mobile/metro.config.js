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
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
