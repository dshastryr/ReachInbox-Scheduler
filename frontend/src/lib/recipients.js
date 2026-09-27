const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;

/** Extract, validate, normalize, and deduplicate email-like tokens from CSV/TXT or pasted text. */
export function parseRecipients(text) {
  const unique = new Set();
  let duplicates = 0;
  let invalid = 0;
  const candidates = String(text ?? "").match(/[^\s,;"<>()[\]]+@[^\s,;"<>()[\]]+/g) ?? [];
  for (const candidate of candidates) {
    const email = candidate.trim().replace(/^[.:]+|[.:]+$/g, "").toLowerCase();
    if (!EMAIL_PATTERN.test(email) || email.length > 254) { invalid += 1; continue; }
    if (unique.has(email)) { duplicates += 1; continue; }
    unique.add(email);
  }
  return { recipients: [...unique], duplicates, invalid, detected: candidates.length };
}

export function mergeRecipients(current, incoming) {
  const all = [...new Set([...current, ...incoming].map((email) => email.toLowerCase()))];
  return { recipients: all, duplicates: current.length + incoming.length - all.length };
}
