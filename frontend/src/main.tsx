import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import App from "./App";
import PlayerSite from "./PlayerSite";

const staff = import.meta.env.MODE === "staff";
document.title = staff ? "Mika Games - Management Portal" : "Mika Games";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      {staff ? <App /> : <PlayerSite />}
    </QueryClientProvider>
  </StrictMode>
);