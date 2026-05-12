<script lang="ts">
  import { env as publicEnv } from "$env/dynamic/public";
  import linearLogo from "$lib/logos/linear.svg?raw";
  import stackedLogo from "$lib/logos/stacked.svg?raw";
  const PUBLIC_TEXCENTER_ITER = publicEnv.PUBLIC_TEXCENTER_ITER ?? "dev";
  let { data, form } = $props();
</script>

<div class="wrap">
  <header class="topbar">
    <div class="brand-group">
      <span class="brand" aria-label="tex.center" role="img">{@html linearLogo}</span>
      <span class="iter">v{PUBLIC_TEXCENTER_ITER || "dev"}</span>
    </div>
    <form method="POST" action="/auth/logout">
      <button type="submit" class="signout">Sign out</button>
    </form>
  </header>

  <main>
    <div class="mark" aria-hidden="true">{@html stackedLogo}</div>
    <h1>Projects</h1>

    {#if data.projects.length === 0}
      <p class="empty">No projects yet.</p>
    {:else}
      <ul class="list">
        {#each data.projects as p (p.id)}
          <li>
            <a href={`/editor/${p.id}`}>{p.name}</a>
          </li>
        {/each}
      </ul>
    {/if}

    <form method="POST" action="?/create" class="create">
      <input
        type="text"
        name="name"
        placeholder="New project name"
        maxlength="200"
        required
      />
      <button type="submit">Create</button>
      {#if form?.reason}
        <span class="err">{form.reason}</span>
      {/if}
    </form>
  </main>
</div>

<style>
  .wrap {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #e5e7eb;
    background: #fafafa;
    font-size: 0.85rem;
  }
  .brand-group {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    line-height: 0;
  }
  .brand :global(svg) {
    height: 1.1rem;
    width: auto;
    display: block;
  }
  .mark {
    display: flex;
    justify-content: center;
    margin: 0 0 1rem;
  }
  .mark :global(svg) {
    height: 4rem;
    width: auto;
    display: block;
  }
  .iter {
    font-size: 0.75rem;
    color: #9ca3af;
  }
  .signout {
    border: 1px solid #d1d5db;
    background: white;
    padding: 0.25rem 0.6rem;
    font-size: 0.8rem;
    border-radius: 4px;
    cursor: pointer;
  }
  main {
    padding: 1.5rem;
    max-width: 640px;
    width: 100%;
    margin: 0 auto;
  }
  h1 {
    font-size: 1.4rem;
    margin: 0 0 1rem;
  }
  .empty {
    color: #6b7280;
  }
  .list {
    list-style: none;
    padding: 0;
    margin: 0 0 1.5rem;
  }
  .list li {
    padding: 0.5rem 0;
    border-bottom: 1px solid #f1f5f9;
  }
  .list a {
    color: #1d4ed8;
    text-decoration: none;
  }
  .list a:hover {
    text-decoration: underline;
  }
  .create {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .create input {
    flex: 1;
    padding: 0.4rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    font-size: 0.9rem;
  }
  .create button {
    padding: 0.4rem 0.9rem;
    border: 1px solid #1d4ed8;
    background: #1d4ed8;
    color: white;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .err {
    color: #b91c1c;
    font-size: 0.85rem;
  }
</style>
