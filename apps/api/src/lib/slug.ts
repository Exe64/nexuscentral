/**
 * Tag slugs: `name` lowercased, non-alphanumerics collapsed to `-`.
 *
 * Generated server-side, never taken from the client (01-SPEC-data-model.md 1.1).
 */

/**
 * Diacritics are folded rather than dropped so that "Réseau" and "Reseau" do not
 * become two different tags. Non-Latin scripts have no ASCII equivalent to fold
 * to, so their characters are kept as-is: a Cyrillic or CJK tag name still
 * produces a usable, unique slug.
 */
export function slugify(name: string): string {
  const folded = name
    .normalize('NFKD')
    // Combining marks left behind by NFKD decomposition.
    .replace(/\p{Mn}/gu, '');

  const slug = folded
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');

  return slug;
}

/**
 * True when a name cannot produce a usable slug -- e.g. `"!!!"`. The API rejects
 * these rather than storing an empty slug that would collide with the next one.
 */
export function isSluggable(name: string): boolean {
  return slugify(name).length > 0;
}
