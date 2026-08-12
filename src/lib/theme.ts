// Client-only theme helpers. "System" is the absence of a stored value; the
// inline script in app.html applies the initial class before first paint.

export function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

export function toggleTheme(): boolean {
  const dark = !isDark();
  document.documentElement.classList.toggle("dark", dark);
  localStorage.setItem("theme", dark ? "dark" : "light");
  return dark;
}
