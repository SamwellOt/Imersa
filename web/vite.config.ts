import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Cabeçalhos de isolamento de origem — SÓ para a página do otimizador do FSRS
// (/otimizar), que roda WASM com threads (SharedArrayBuffer). No app inteiro
// eles bloqueariam qualquer recurso externo sem CORP. Em produção quem faz isso
// é o server/ (ver server/index.mjs); aqui é o equivalente para o `vite dev`.
export const COI_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

function otimizarPage(): Plugin {
  return {
    name: "imersa-otimizar",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (url === "/otimizar" || url.startsWith("/otimizar?")) {
          req.url = "/otimizar.html" + url.slice("/otimizar".length);
        }
        if (req.url?.startsWith("/otimizar")) {
          for (const [k, v] of Object.entries(COI_HEADERS)) res.setHeader(k, v);
        }
        // Todo script pode virar worker da página isolada, e worker só carrega
        // se o próprio script trouxer COEP. Nos demais recursos é inofensivo.
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        next();
      });
    },
  };
}

// Content (doses + media) is served from the repo-level content/ dir via a symlink
// at public/content -> ../../content (created by scripts/link-content.sh).
export default defineConfig({
  plugins: [react(), tailwindcss(), otimizarPage()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // o wasm + workers do fsrs-browser não sobrevivem ao pré-bundle do esbuild
  optimizeDeps: { exclude: ["fsrs-browser"] },
  worker: { format: "es" },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        otimizar: fileURLToPath(new URL("./otimizar.html", import.meta.url)),
      },
    },
  },
  server: { port: 5173, host: true },
});
