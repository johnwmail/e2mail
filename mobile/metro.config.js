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

// Metro 0.84 enables package.json `exports` by default. For native that picks the
// `import` condition, so `openpgp` resolves to its Node build (`node:crypto`/`module`),
// which cannot be bundled by Hermes. Prefer the `browser` condition (matching Metro's
// `resolverMainFields: ['react-native', 'browser', 'main']`) so it resolves the
// self-contained `dist/openpgp.min.mjs` build. Without this, native `expo export` fails.
config.resolver.unstable_conditionNames = [
  ...(config.resolver.unstable_conditionNames ?? []),
  'browser',
];

module.exports = config;
