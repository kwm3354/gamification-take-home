import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./base.css";
import "./play.css";
import "./admin.css";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
