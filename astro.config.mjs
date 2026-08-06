// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';

export default defineConfig({
  output: 'static',
  site: 'https://newlevel.church',
  trailingSlash: 'ignore',
  integrations: [sitemap(), react()],
  vite: {
    plugins: [tailwindcss()]
  }
});
