import type { IconName } from './ui-icons';

/* Category color and icon (docs/DESIGN.md カテゴリの色). Color only supports the name, which is always shown as text. */
export type CategoryTone = 'food' | 'daily' | 'transport' | 'fun' | 'util' | 'comm' | 'other';

const TONES: readonly CategoryTone[] = ['food', 'daily', 'transport', 'fun', 'util', 'comm', 'other'];
const KNOWN: ReadonlyArray<{ match: RegExp; tone: CategoryTone; icon: IconName }> = [
  { match: /食費|食料|外食|食品/, tone: 'food', icon: 'cart' },
  { match: /日用品|生活用品/, tone: 'daily', icon: 'basket' },
  { match: /交通|電車|バス|ガソリン/, tone: 'transport', icon: 'train' },
  { match: /娯楽|趣味|レジャー/, tone: 'fun', icon: 'heart' },
  { match: /衣服|衣類|被服/, tone: 'fun', icon: 'shirt' },
  { match: /光熱|水道|電気|ガス/, tone: 'util', icon: 'bulb' },
  { match: /通信|携帯|スマホ|インターネット/, tone: 'comm', icon: 'phone' },
  { match: /医療|病院|薬/, tone: 'comm', icon: 'medical' },
];

function stableIndex(key: string) {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % (TONES.length - 1);
}

export function categoryTone(name: string, id: string | null = null): { tone: CategoryTone; icon: IconName } {
  const known = KNOWN.find(entry => entry.match.test(name));
  if (known) return { tone: known.tone, icon: known.icon };
  return { tone: TONES[stableIndex(id ?? name)], icon: 'tag' };
}
