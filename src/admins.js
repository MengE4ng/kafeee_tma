// Who may manage the menu.
//  - Owners: listed in ADMIN_IDS (.env / Render), by Telegram ID or @username, e.g. ADMIN_IDS=765537040,@sokha
//  - Managers: added by an owner from Telegram with /addadmin @username (saved in the database)
const db = require('./db');

const norm = (v) => {
  const s = String(v || '').trim();
  if (/^-?\d+$/.test(s)) return s;                 // numeric Telegram ID
  const u = s.replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '').toLowerCase();
  return u ? '@' + u : '';
};
const owners = () => String(process.env.ADMIN_IDS || '').split(',').map(norm).filter(Boolean);
const managers = () => db.getSetting('menuManagers', []);

const matches = (list, user) => Boolean(user) && (
  list.includes(String(user.id)) || (user.username ? list.includes('@' + String(user.username).toLowerCase()) : false));

const isOwner = (user) => matches(owners(), user);
const isAdmin = (user) => isOwner(user) || matches(managers(), user);

function addManager(value) {
  const v = norm(value);
  if (!v || v === '@') return null;
  const list = managers();
  if (list.includes(v) === false) db.setSetting('menuManagers', [...list, v]);
  return v;
}
function removeManager(value) {
  const v = norm(value);
  const list = managers();
  db.setSetting('menuManagers', list.filter((x) => x !== v));
  return list.includes(v) ? v : null;
}

module.exports = { isOwner, isAdmin, owners, managers, addManager, removeManager };
