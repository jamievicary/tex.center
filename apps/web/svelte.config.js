import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: "index.html",
    }),
    typescript: {
      config: (cfg) => ({
        ...cfg,
        extends: "../../../tsconfig.base.json",
      }),
    },
  },
};

export default config;
