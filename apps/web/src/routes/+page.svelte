<!--
  Per GOAL.md the unauthenticated landing page must reveal NOTHING
  about what the service is — no name, description, or marketing
  copy — only the sign-in widget. A plain anchor (styled as a button)
  pointing at /auth/google/start kicks off the Authorization Code +
  PKCE flow: the route mints the state cookie and 302s to Google.
  Anchor rather than <button onclick> so the flow works without JS.
-->

<main>
  <a class="signin" href="/auth/google/start">Sign in with Google</a>
</main>

<style>
  main {
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: #ffffff;
  }
  .signin {
    font: inherit;
    padding: 0.75rem 1.25rem;
    border: 1px solid #dadce0;
    border-radius: 4px;
    background: #ffffff;
    color: inherit;
    text-decoration: none;
    cursor: pointer;
  }
  .signin:hover {
    background: #f8f9fa;
  }
</style>
