export function useBuildInfo() {
  const buildDate = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : null;

  const formatted = buildDate
    ? new Date(buildDate).toISOString().replace('T', ' ').substring(0, 19)
    : null;

  return { buildDate: formatted };
}
