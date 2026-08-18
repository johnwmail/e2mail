export const buildInfo = {
  version: import.meta.env.VITE_APP_VERSION || 'vdev',
  buildTime: import.meta.env.VITE_APP_BUILD_TIME || 'timeless',
  commitHash: import.meta.env.VITE_APP_COMMIT_HASH || 'sha-unknown',
};