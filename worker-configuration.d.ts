// Portable declarations: production values belong only in ignored local config.
declare namespace Cloudflare {
  interface GlobalProps { mainModule: typeof import('./src/index'); }
  interface Env { OAUTH_KV: KVNamespace; }
}
interface Env extends Cloudflare.Env {}
