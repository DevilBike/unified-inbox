// The fixed set of folders shared by every mailbox.
export const FOLDERS = [
  { key: 'inbox', name: 'Inbox' },
  { key: 'receipts', name: 'Receipts' },
  { key: 'finance', name: 'Finance' },
  { key: 'jobs', name: 'Jobs' },
  { key: 'news', name: 'News' },
  { key: 'promotions', name: 'Promotions' },
];

// Folders that rules can move mail into (everything except Inbox).
export const TARGET_FOLDERS = FOLDERS.filter((f) => f.key !== 'inbox');

export const FOLDER_KEYS = FOLDERS.map((f) => f.key);

const ALIASES = {
  'receipts & orders': 'receipts',
  'receipts and orders': 'receipts',
  orders: 'receipts',
  'bills & finance': 'finance',
  bills: 'finance',
  'news & social': 'news',
  'news and social': 'news',
  social: 'news',
  promos: 'promotions',
  marketing: 'promotions',
};

// Map a label or folder name from Gmail/Outlook to one of our folder keys.
export function folderKeyFromName(name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  const direct = FOLDERS.find((f) => f.name.toLowerCase() === n || f.key === n);
  if (direct) return direct.key;
  return ALIASES[n] || null;
}

export function folderName(key) {
  const f = FOLDERS.find((x) => x.key === key);
  return f ? f.name : key;
}
