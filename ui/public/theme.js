// The remembered theme, or the system's. Runs before the page renders so the
// first paint already has the right colours.
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem("apg-theme");
  } catch (e) {
    // storage can be unavailable in a frame
  }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
