import { initI18n } from "./i18n/index.js";
import "./styles.css";

// Initialize i18n before loading the app
void initI18n().then(() => {
  // App is loaded after i18n is ready
  void import("./ui/app.js");
});
