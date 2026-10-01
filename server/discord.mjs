const API = 'https://discord.com/api/v10';
export class AccessError extends Error {
  constructor(message, status = 403) { super(message); this.status = status; }
}
export function verifyInstance(instance, userId, requestedId, config) {
  if (instance.application_id !== config.clientId || instance.instance_id !== requestedId ||
      !instance.users?.includes(userId) || instance.location?.kind !== 'gc' ||
      !config.guilds.has(instance.location.guild_id) ||
      (config.channels.size && !config.channels.has(instance.location.channel_id))) {
    throw new AccessError('Join this Activity in an allowed development server voice channel.');
  }
  return instance;
}
export function discordService(config, fetcher = fetch) {
  async function request(path, options = {}) {
    const response = await fetcher(`${API}${path}`, { ...options, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new AccessError('Discord could not verify this Activity session. Try launching it again.', response.status === 429 ? 429 : 403);
    return response.json();
  }
  return {
    async authorize(code, instanceId) {
      if (!config.clientId || !config.secret || !config.botToken || !config.guilds.size)
        throw new AccessError('The host still needs its Discord credentials and development server ID.', 503);
      const token = await request('/oauth2/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.secret,
          grant_type: 'authorization_code', code }),
      });
      if (!token.access_token) throw new AccessError('Discord authorization did not return a token.');
      const user = await request('/users/@me', { headers: { authorization: `Bearer ${token.access_token}` } });
      const instance = await this.instance(instanceId, user.id);
      return { accessToken: token.access_token, user, instance };
    },
    async instance(instanceId, userId) {
      const instance = await request(`/applications/${config.clientId}/activity-instances/${encodeURIComponent(instanceId)}`,
        { headers: { authorization: `Bot ${config.botToken}` } });
      verifyInstance(instance, userId, instanceId, config);
      const channel = await request(`/channels/${instance.location.channel_id}`,
        { headers: { authorization: `Bot ${config.botToken}` } });
      if (channel.type !== 2 || channel.guild_id !== instance.location.guild_id)
        throw new AccessError('Launch SM64 from a voice channel in your development server.');
      return instance;
    },
  };
}
