// The old pocketbot.mrjoedang.workers.dev address: the production Worker was named `pocketbot` until 2026-11-16 (now
// `paperbot`), and boards flashed with this address still call it. Every request passes through unchanged to paperbot
// over a service binding: paperbot serves /v1 and /admin on old addresses and 301s web pages to https://app.paperbot.ca.
interface Env { PAPERBOT: Fetcher }

export default {
  fetch: (req: Request, env: Env) => env.PAPERBOT.fetch(req),
} satisfies ExportedHandler<Env>;
