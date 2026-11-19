// A light warning when a sender's display name claims a well-known brand but
// the address is from an unrelated domain (e.g. "Canada Post" from surveymonkeyuser.com).

const BRANDS = [
  { label: 'Canada Post', words: ['canada post', 'postes canada'], domains: ['canadapost.ca', 'canadapost-postescanada.ca', 'postescanada.ca'] },
  { label: 'USPS', words: ['usps'], domains: ['usps.com', 'usps.gov'] },
  { label: 'FedEx', words: ['fedex'], domains: ['fedex.com'] },
  { label: 'UPS', words: ['ups'], domains: ['ups.com'] },
  { label: 'DHL', words: ['dhl'], domains: ['dhl.com'] },
  { label: 'Amazon', words: ['amazon'], domains: ['amazon.com', 'amazon.ca', 'amazonses.com'] },
  { label: 'PayPal', words: ['paypal'], domains: ['paypal.com', 'paypal.ca'] },
  { label: 'Chase', words: ['chase'], domains: ['chase.com', 'jpmorgan.com'] },
  { label: 'Microsoft', words: ['microsoft', 'outlook'], domains: ['microsoft.com', 'outlook.com', 'live.com', 'office.com'] },
  { label: 'Google', words: ['google', 'gmail'], domains: ['google.com', 'gmail.com', 'youtube.com'] },
  { label: 'Apple', words: ['apple', 'icloud'], domains: ['apple.com', 'icloud.com'] },
  { label: 'Netflix', words: ['netflix'], domains: ['netflix.com'] },
  { label: 'Bank of America', words: ['bank of america'], domains: ['bankofamerica.com'] },
  { label: 'Wells Fargo', words: ['wells fargo'], domains: ['wellsfargo.com'] },
  { label: 'the IRS', words: ['irs'], domains: ['irs.gov'] },
  { label: 'the CRA', words: ['cra', 'canada revenue'], domains: ['canada.ca', 'cra-arc.gc.ca'] },
];

// Greek, Cyrillic and Coptic letters that scammers use to look like Latin ones.
const CONFUSABLES = {
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  'ο': 'o', 'ρ': 'p', 'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'τ': 't', 'υ': 'u', 'χ': 'x',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's',
  'Ⲁ': 'A', 'ⲁ': 'a', 'Ⲃ': 'B', 'Ⲉ': 'E', 'ⲉ': 'e', 'Ⲓ': 'I', 'ⲓ': 'i', 'Ⲕ': 'K', 'Ⲙ': 'M', 'Ⲛ': 'N', 'Ⲟ': 'O', 'ⲟ': 'o', 'Ⲣ': 'P', 'ⲣ': 'p', 'Ⲥ': 'C', 'ⲥ': 'c', 'Ⲧ': 'T', 'Ⲭ': 'X',
};

function normalize(s) {
  // NFKC turns fancy look-alike letters (𝖠, Ｃ) into plain ones; the map handles the rest.
  return String(s || '').normalize('NFKC').replace(/[^\x00-\x7f]/g, (c) => CONFUSABLES[c] || c).toLowerCase().replace(/[^a-z0-9@. ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function domainOf(address) {
  return String(address || '').toLowerCase().split('@')[1] || '';
}

function endsWithDomain(domain, d) {
  return domain === d || domain.endsWith(`.${d}`);
}

// Returns a short warning string, or null.
export function phishingHint(from, subject = '', snippet = '') {
  const name = normalize(from?.name);
  // Brand names at the very start of the message act like a fake letterhead.
  // Only used when the sender gives no name, so newsletters about a brand don't trip it.
  const head = name ? '' : normalize(snippet).slice(0, 40);
  const domain = domainOf(from?.address);
  if (!domain) return null;
  for (const b of BRANDS) {
    const hit = b.words.find((w) => new RegExp(`(^| )${w}( |$)`).test(name) || (w.length > 4 && head.startsWith(w)));
    if (hit && !b.domains.some((d) => endsWithDomain(domain, d))) {
      return `This says it's from ${b.label}, but it was sent from ${domain}. Be careful with links.`;
    }
  }
  return null;
}
