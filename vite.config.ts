import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  base: '/ModelMe/', // This must match your GitHub repository name
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        renderer: 'renderer.html',
      },
    },
  },
});
