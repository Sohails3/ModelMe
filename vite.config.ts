import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  base: '/', // Updated to root because you are using a custom domain (model-me.net)
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        renderer: 'renderer.html',
      },
    },
  },
});
