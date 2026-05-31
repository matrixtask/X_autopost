export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '0.0.0.0',
  timezone: process.env.TIMEZONE || 'Asia/Tokyo',
  dataFile: process.env.DATA_FILE || new URL('../data/posts.json', import.meta.url).pathname,
  adminToken: process.env.ADMIN_TOKEN || '',
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 8787}`,
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  xUserAccessToken: process.env.X_USER_ACCESS_TOKEN || '',
  dryRun: process.env.DRY_RUN !== 'false'
};

export function requireAdminToken() {
  if (!config.adminToken) {
    throw new Error('ADMIN_TOKEN is required for write operations.');
  }
}
