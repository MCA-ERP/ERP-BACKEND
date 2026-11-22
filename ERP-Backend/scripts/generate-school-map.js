const fs = require('fs');
const m = JSON.parse(fs.readFileSync('C:/Users/JenuHariharan/Desktop/MCA-ERP/ERP-FRONTEND/ERP-Frontend/src/app/school/s/menu.json', 'utf8'));
const built = Object.keys(m);
const href = (mod, sec) => (mod === 'dashboard' && sec === 'main-dashboard' ? '/school' : `/school/${mod}/${sec}`);
const lines = [];
for (const k of built) {
  const mod = m[k];
  lines.push(`${mod.label}`);
  for (const s of mod.sections) {
    const pages = s.pages.length > 1 ? s.pages.map((p) => `${p.title} [?tab=${p.key}]`).join('; ') : '';
    lines.push(`  - ${s.label} (${href(k, s.key)})${pages ? ': ' + pages : ''}`);
  }
}
fs.writeFileSync('C:/Users/JenuHariharan/Desktop/MCA-ERP/ERP-BACKEND/ERP-Backend/src/modules/school/school-portal-map.ts',
  '/** The pages of the School Admin portal that are built, with their addresses. Generated from the portal menu. */\nexport const SCHOOL_MENU = ' + JSON.stringify(lines.join('\n')) + ';\n');
console.log(lines.length);
