<script lang="ts">
  // Mock auth: real Google OAuth lands in M5. For now, the button
  // simply navigates to the editor stub. Per GOAL.md the unauthenticated
  // page must reveal NOTHING about what the service is — no name, no
  // description, no marketing — only the sign-in button.
  function signIn() {
    window.location.assign("/editor");
  }
</script>

<main>
  <button type="button" onclick={signIn}>Sign in with Google</button>
</main>

<style>
  main {
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: #ffffff;
  }
  button {
    font: inherit;
    padding: 0.75rem 1.25rem;
    border: 1px solid #dadce0;
    border-radius: 4px;
    background: #ffffff;
    cursor: pointer;
  }
  button:hover {
    background: #f8f9fa;
  }
</style>
