// vite.config.ts
import { sveltekit } from "file:///home/jamievicary/.cache/tex-center-nm/e7b568589fe4/node_modules/@sveltejs/kit/src/exports/vite/index.js";
import { defineConfig } from "file:///home/jamievicary/.cache/tex-center-nm/e7b568589fe4/node_modules/vite/dist/node/index.js";
var vite_config_default = defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 3e3,
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:3001",
        ws: true,
        changeOrigin: true
      }
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvbW50L2MvZHJvcGJveC9hY2FkZW1pYS9wcm9qZWN0cy8yMDI2LXN1cGVydGV4L3RleC1jZW50ZXIvYXBwcy93ZWJcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9tbnQvYy9kcm9wYm94L2FjYWRlbWlhL3Byb2plY3RzLzIwMjYtc3VwZXJ0ZXgvdGV4LWNlbnRlci9hcHBzL3dlYi92aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vbW50L2MvZHJvcGJveC9hY2FkZW1pYS9wcm9qZWN0cy8yMDI2LXN1cGVydGV4L3RleC1jZW50ZXIvYXBwcy93ZWIvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBzdmVsdGVraXQgfSBmcm9tIFwiQHN2ZWx0ZWpzL2tpdC92aXRlXCI7XG5pbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tIFwidml0ZVwiO1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICBwbHVnaW5zOiBbc3ZlbHRla2l0KCldLFxuICBzZXJ2ZXI6IHtcbiAgICBwb3J0OiAzMDAwLFxuICAgIHByb3h5OiB7XG4gICAgICBcIi93c1wiOiB7XG4gICAgICAgIHRhcmdldDogXCJ3czovLzEyNy4wLjAuMTozMDAxXCIsXG4gICAgICAgIHdzOiB0cnVlLFxuICAgICAgICBjaGFuZ2VPcmlnaW46IHRydWUsXG4gICAgICB9LFxuICAgIH0sXG4gIH0sXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBd1gsU0FBUyxpQkFBaUI7QUFDbFosU0FBUyxvQkFBb0I7QUFFN0IsSUFBTyxzQkFBUSxhQUFhO0FBQUEsRUFDMUIsU0FBUyxDQUFDLFVBQVUsQ0FBQztBQUFBLEVBQ3JCLFFBQVE7QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxNQUNMLE9BQU87QUFBQSxRQUNMLFFBQVE7QUFBQSxRQUNSLElBQUk7QUFBQSxRQUNKLGNBQWM7QUFBQSxNQUNoQjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
