/* WCAG 2.1 contrast verification for the Steel Yard Ledger palette (final values). */
function lum(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) / Math.min(la, lb)).toFixed(2);
}

const L = {
  bg: "#f6f4e8", bg2: "#f2efe3", card: "#ffffff", ink: "#161920",
  inkSoft: "#3d4247", steel: "#5d6670", line: "#a7afa6", accent: "#b86a00",
  accentFg: "#ffffff", ok: "#166e3d", okBg: "#e3efe7", okInk: "#1f6f43",
  oxide: "#a03024", oxideBg: "#f6e3df", oxideInk: "#a03024",
  noteBg: "#f5ecd0", noteInk: "#6b5510",
  soon: "#b45309", soonBg: "#fbeed7", soonInk: "#8a4a06"
};
const D = {
  bg: "#0e1117", bg2: "#131a24", card: "#171b22", ink: "#f3f5f8",
  inkSoft: "#b9c0cb", steel: "#8a94a0", line: "#263042", accent: "#ffd84d",
  accentFg: "#161920", ok: "#4dd89c", okBg: "#133a2e", okInk: "#4dd89c",
  oxide: "#ff8a65", oxideBg: "#331812", oxideInk: "#ff8a65",
  noteBg: "#332e1a", noteInk: "#e8d37a",
  soon: "#ffae5e", soonBg: "#331f10", soonInk: "#ffae5e"
};

const pairs = [
  ["L ink on bg", L.ink, L.bg],
  ["L inkSoft on bg", L.inkSoft, L.bg],
  ["L steel on bg", L.steel, L.bg],
  ["L line on bg", L.line, L.bg],
  ["L line on card", L.line, L.card],
  ["L accent on card", L.accent, L.card],
  ["L white on accent", L.accentFg, L.accent],
  ["L ok on okBg", L.ok, L.okBg],
  ["L oxide on oxideBg", L.oxideInk, L.oxideBg],
  ["L noteInk on noteBg", L.noteInk, L.noteBg],
  ["L soon on soonBg", L.soonInk, L.soonBg],
  ["L soon on card", L.soon, L.card],
  ["D ink on bg", D.ink, D.bg],
  ["D inkSoft on bg", D.inkSoft, D.bg],
  ["D line on bg", D.line, D.bg],
  ["D accent on card", D.accent, D.card],
  ["D card on accent", D.card, D.accent],
  ["D ok on okBg", D.ok, D.okBg],
  ["D oxide on oxideBg", D.oxideInk, D.oxideBg],
  ["D noteInk on noteBg", D.noteInk, D.noteBg],
  ["D soon on soonBg", D.soon, D.soonBg],
  ["D soon on card", D.soon, D.card],
  ["D card on bg", D.card, D.bg]
];
let min = Infinity;
for (const [name, a, b] of pairs) {
  const r = ratio(a, b);
  min = Math.min(min, parseFloat(r));
  console.log(name.padEnd(26) + r + ":1");
}
console.log("\nMinimum (AA text=4.5, UI components=3.0): " + min.toFixed(2) + ":1");
