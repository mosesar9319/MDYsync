// Cloud Chaburah Live: tells the page whether background alerts are set up on this server and
// hands it the public VAPID key (a public value by design) to subscribe with. The private key
// and the service key never leave the server.

import { pushConfig } from '../../shared/live-push.mjs';

const env = (name) => (typeof Netlify !== 'undefined' ? Netlify.env.get(name) : process.env[name]);

export default async () => {
  const config = pushConfig(env);
  return new Response(JSON.stringify(config ? { available: true, publicKey: config.publicKey } : { available: false }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
  });
};
