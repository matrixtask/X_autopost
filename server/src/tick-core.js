import { dueApprovedPosts, updatePost } from './storage.js';
import { publishTweet } from './x-client.js';

export async function publishDuePosts(now = new Date()) {
  const due = await dueApprovedPosts(now);
  const results = [];
  for (const post of due) {
    try {
      const result = await publishTweet(post.content);
      const tweetId = result?.data?.id || result.id;
      await updatePost(
        post.id,
        { status: 'posted', postedAt: new Date().toISOString(), tweetId, publishResult: result },
        { type: 'published', tweetId }
      );
      results.push({ id: post.id, ok: true, tweetId });
    } catch (error) {
      await updatePost(post.id, { status: 'failed', lastError: error.message }, { type: 'publish_failed', error: error.message });
      results.push({ id: post.id, ok: false, error: error.message });
    }
  }
  return results;
}
