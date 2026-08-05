import { hydrate } from "preact";
import { App } from "../ui/App";
import "../styles/app.css";

/**
 * The browser entry point. The Worker already rendered this exact tree, so the form is
 * readable before this file arrives and `hydrate` only has to attach the behaviour.
 *
 * Importing the stylesheet here is what makes esbuild emit it alongside the script, so the
 * two assets are produced and hashed by the same build.
 */
const root = document.getElementById("root");
if (root) hydrate(<App />, root);
