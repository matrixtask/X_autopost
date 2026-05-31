import { config } from './config.js';

export async function publishTweet(content) {
  if (config.dryRun) {
    return { dryRun: true, id: `dry-${Date.now()}`, text: content };
  }
  if (!config.xUserAccessToken) {
    throw new Error('X_USER_ACCESS_TOKEN is required when DRY_RUN=false.');
  }
  const response = await fetch('https://api.x.com/2/tweets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.xUserAccessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text: content })
  });
  if (!response.ok) {
    throw new Error(`X publish failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}
