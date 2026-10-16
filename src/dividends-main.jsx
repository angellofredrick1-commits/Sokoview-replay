import React from "react";
import ReactDOM from "react-dom/client";
import DividendCalendar from "./DividendCalendar.jsx";

// Deliberately not importing index.css: this page carries its own scoped styles.
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode><DividendCalendar /></React.StrictMode>
);
