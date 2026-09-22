// Every feature that posts to a specific channel reads from here instead
// of hardcoding an ID inline. Add a new env var + a new key here whenever
// a new feature needs its own channel (e.g. LEVEL_UP_CHANNEL_ID).
export const CHANNELS = {
  welcome: process.env.WELCOME_CHANNEL_ID,
  roleSelect: process.env.ROLE_SELECT_CHANNEL_ID,
  announcements: process.env.ANNOUNCEMENTS_CHANNEL_ID,
  modLog: process.env.MOD_LOG_CHANNEL_ID,
};

// Small helper so callers don't repeat the "fetch by id" boilerplate
// or crash with an unhelpful error if a channel ID was never set.
export async function getChannel(client, key) {
  const id = CHANNELS[key];
  if (!id) {
    console.warn(`No channel ID configured for "${key}" — check your .env`);
    return null;
  }
  return client.channels.fetch(id);
}
