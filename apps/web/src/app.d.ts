// See https://svelte.dev/docs/kit/types#app
import type { ResolvedSession } from "$lib/server/sessionHook.js";

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      /** Authenticated session, populated by `hooks.server.ts`. */
      session: ResolvedSession | null;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
