import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// adapter-node so the control plane can serve auth + API routes
// from the same origin as the editor shell. The white sign-in page
// and editor shell still ship as client-only artefacts (the
// per-route `prerender = true; ssr = false` defaults in
// routes/+layout.ts are unchanged); only dynamic `+server.ts`
// endpoints (added by M5.1 onward) opt out per-route.

const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    typescript: {
      config: (cfg) => ({
        ...cfg,
        extends: "../../../tsconfig.base.json",
      }),
    },
  },
};

export default config;
